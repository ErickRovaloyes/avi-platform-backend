'use strict'
const pool = require('../db')
const { parseJ } = require('../utils')
const { storeMediaInternal } = require('./media.controller')
const { downloadWhatsAppMedia, downloadFromUrl } = require('../services/metaMedia')
const flow = require('../flow/process')
const flowStore = require('../flow/store')

const messageQueue = []
const sseClients   = new Set()

// Resolve the agent's channel config so we can authenticate against the Meta API
async function getAgentChannelConfig(accId, agentId, channelType) {
  try {
    const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agentId, accId])
    const channels = parseJ(ag?.channels, [])
    return channels.find(c => c.type === channelType && c.status === 'connected')?.config || {}
  } catch { return {} }
}

// Inline-download every media object referenced in an incoming WhatsApp payload,
// store it in our DB, and rewrite the message so it includes our internal mediaId.
// This way the (browser-side) webhookHandler doesn't need direct access to the
// Graph API token — it just consumes a pre-resolved internal mediaId.
async function enrichWhatsAppPayloadWithMedia(accId, agentId, payload) {
  const cfg = await getAgentChannelConfig(accId, agentId, 'whatsapp')
  if (!cfg.accessToken) return payload
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages || []
  for (const m of messages) {
    const mediaObj = m.image || m.video || m.audio || m.document || m.sticker
    if (!mediaObj?.id) continue
    try {
      const dl = await downloadWhatsAppMedia({
        accessToken: cfg.accessToken,
        mediaId: mediaObj.id,
        suggestedFilename: m.document?.filename || `${m.type}_${m.id}.${(mediaObj.mime_type || '').split('/').pop() || 'bin'}`,
      })
      // Store with conversation_id='' for now (we don't know it yet — the browser side
      // will look it up when creating the convo). The key thing is that the mediaId is valid.
      const stored = await storeMediaInternal({
        accId, convId: '_pending_', messageId: null,
        buffer: dl.buffer, mime: mediaObj.mime_type || dl.mime,
        filename: dl.filename, kind: undefined, ts: Date.now(),
      })
      m._internalMedia = {
        mediaId: stored.id, kind: stored.kind, mime: stored.mime,
        filename: stored.filename || dl.filename, sizeBytes: stored.sizeBytes,
      }
    } catch (e) {
      console.warn('[WA media download]', e.message)
    }
  }
  return payload
}

async function enrichMessengerPayloadWithMedia(accId, agentId, payload) {
  // Messenger attaches public URLs directly to the webhook payload, no token needed
  for (const entry of (payload.entry || [])) {
    for (const evt of (entry.messaging || [])) {
      for (const att of (evt.message?.attachments || [])) {
        const url = att.payload?.url
        if (!url) continue
        try {
          const dl = await downloadFromUrl(url)
          // Guess kind from att.type
          const kind = att.type === 'image' ? 'image' : att.type === 'video' ? 'video' : att.type === 'audio' ? 'audio' : 'file'
          const stored = await storeMediaInternal({
            accId, convId: '_pending_',
            buffer: dl.buffer, mime: dl.mime, filename: dl.filename, kind, ts: Date.now(),
          })
          att._internalMedia = {
            mediaId: stored.id, kind: stored.kind, mime: stored.mime,
            filename: stored.filename, sizeBytes: stored.sizeBytes,
          }
        } catch (e) { console.warn('[FB media download]', e.message) }
      }
    }
  }
  return payload
}

async function enrichInstagramPayloadWithMedia(accId, agentId, payload) {
  // IG follows the same shape as Messenger
  return enrichMessengerPayloadWithMedia(accId, agentId, payload)
}

function pushSSE(event) {
  messageQueue.push(event)
  if (messageQueue.length > 50) messageQueue.shift()
  const data = `data: ${JSON.stringify(event)}\n\n`
  sseClients.forEach(client => { try { client.write(data) } catch { sseClients.delete(client) } })
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

const whatsappVerify = (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge } = req.query
  mode === 'subscribe' ? res.status(200).send(challenge) : res.sendStatus(403)
}

const whatsappReceive = async (req, res) => {
  const { accId, agentId } = req.params
  const value = req.body?.entry?.[0]?.changes?.[0]?.value || {}
  const msgs = value.messages || []
  const statuses = value.statuses || []

  // Acuses de estado (sent/delivered/read) de mensajes salientes
  if (!msgs.length && statuses.length) {
    res.sendStatus(200)
    for (const st of statuses) {
      flowStore.updateMessageStatus(st.id, st.status).catch(e => console.error('[WA status]', e.message))
    }
    return
  }
  if (!msgs.length) return res.sendStatus(200)
  // ACK immediately to Meta; do the (potentially slow) media download in the background
  res.sendStatus(200)
  let payload = req.body
  try {
    payload = await enrichWhatsAppPayloadWithMedia(accId, agentId, req.body)
  } catch (e) {
    console.error('[whatsappReceive] media enrich', e)
  }
  // El flujo se ejecuta EN EL SERVIDOR (la IA responde aunque nadie tenga la
  // plataforma abierta). El SSE solo lleva una SEÑAL para refrescar la UI — SIN
  // payload, para que cualquier navegador con bundle viejo en caché (que esperaba
  // `payload`) se detenga y deje de procesar/responder en paralelo.
  pushSSE({ type: 'whatsapp', accId, agentId, ts: Date.now() })
  flow.processWhatsApp(accId, agentId, payload).catch(e => console.error('[flow WA]', e))
}

// ── Messenger ─────────────────────────────────────────────────────────────────

const messengerVerify = (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge } = req.query
  mode === 'subscribe' ? res.status(200).send(challenge) : res.sendStatus(403)
}

const messengerReceive = async (req, res) => {
  const { accId, agentId } = req.params
  if (req.body?.object !== 'page') return res.sendStatus(200)
  res.sendStatus(200)
  let payload = req.body
  try {
    payload = await enrichMessengerPayloadWithMedia(accId, agentId, req.body)
  } catch (e) {
    console.error('[messengerReceive] media enrich', e)
  }
  pushSSE({ type: 'messenger', accId, agentId, ts: Date.now() })
  flow.processMessenger(accId, agentId, payload).catch(e => console.error('[flow FB]', e))
}

// ── Instagram ─────────────────────────────────────────────────────────────────

const instagramVerify = (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge } = req.query
  mode === 'subscribe' ? res.status(200).send(challenge) : res.sendStatus(403)
}

const instagramReceive = async (req, res) => {
  const { accId, agentId } = req.params
  if (req.body?.object !== 'instagram') return res.sendStatus(200)
  res.sendStatus(200)
  let payload = req.body
  try {
    payload = await enrichInstagramPayloadWithMedia(accId, agentId, req.body)
  } catch (e) {
    console.error('[instagramReceive] media enrich', e)
  }
  pushSSE({ type: 'instagram', accId, agentId, ts: Date.now() })
  flow.processInstagram(accId, agentId, payload).catch(e => console.error('[flow IG]', e))
}

// ── SSE stream ────────────────────────────────────────────────────────────────

const sseStream = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n') } catch { clearInterval(hb) } }, 20000)
  // NO reenviar eventos al reconectar: cada evento dispara el envío real de la
  // respuesta al cliente (WhatsApp/Messenger/IG) desde el navegador. Reenviarlos
  // al recargar/redeploy provocaba reenvío de respuestas ya entregadas.
  sseClients.add(res)
  req.on('close', () => { clearInterval(hb); sseClients.delete(res) })
}

// ── Test / debug ──────────────────────────────────────────────────────────────

const testMessage = (req, res) => {
  const { accId, agentId, phoneNumberId, from, text, fromName, channel = 'whatsapp' } = req.body
  let payload, type
  if (channel === 'messenger') {
    type    = 'messenger'
    payload = { object: 'page', entry: [{ id: phoneNumberId || 'page_test', messaging: [{ sender: { id: from }, recipient: { id: phoneNumberId }, timestamp: Date.now(), message: { mid: 'test_' + Date.now(), text } }] }] }
  } else if (channel === 'instagram') {
    type    = 'instagram'
    payload = { object: 'instagram', entry: [{ id: phoneNumberId || 'ig_test', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from, profile: { name: fromName || 'Test' } }], messages: [{ id: 'test_' + Date.now(), from, type: 'text', timestamp: String(Date.now()), text: { body: text } }] } }] }] }
  } else {
    type    = 'whatsapp'
    payload = { object: 'whatsapp_business_account', entry: [{ id: 'test', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId, display_phone_number: 'TEST' }, contacts: [{ wa_id: from, profile: { name: fromName || 'Test User' } }], messages: [{ id: 'test_' + Date.now(), from, type: 'text', timestamp: String(Date.now()), text: { body: text } }] } }] }] }
  }
  pushSSE({ type, accId, agentId, ts: Date.now() })
  if (type === 'messenger')      flow.processMessenger(accId, agentId, payload).catch(e => console.error('[flow FB test]', e))
  else if (type === 'instagram') flow.processInstagram(accId, agentId, payload).catch(e => console.error('[flow IG test]', e))
  else                           flow.processWhatsApp(accId, agentId, payload).catch(e => console.error('[flow WA test]', e))
  res.json({ ok: true, channel, sseClients: sseClients.size })
}

const getDebug = (req, res) => {
  const socket = require('../services/socket')
  res.json({ sseClients: sseClients.size, queue: messageQueue.length, wsRooms: socket.io?.sockets?.adapter?.rooms?.size || 0 })
}

const getHealth = (req, res) => res.json({ status: 'ok', sseClients: sseClients.size })

module.exports = {
  whatsappVerify, whatsappReceive,
  messengerVerify, messengerReceive,
  instagramVerify, instagramReceive,
  sseStream, testMessage, getDebug, getHealth,
}
