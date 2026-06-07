'use strict'
const pool = require('../db')
const { parseJ } = require('../utils')
const { storeMediaInternal } = require('./media.controller')
const { downloadWhatsAppMedia, downloadFromUrl } = require('../services/metaMedia')

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
  const msgs = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || []
  if (!msgs.length) return res.sendStatus(200)
  // ACK immediately to Meta; do the (potentially slow) media download in the background
  res.sendStatus(200)
  try {
    const payload = await enrichWhatsAppPayloadWithMedia(accId, agentId, req.body)
    pushSSE({ type: 'whatsapp', accId, agentId, payload, ts: Date.now() })
  } catch (e) {
    console.error('[whatsappReceive]', e)
    pushSSE({ type: 'whatsapp', accId, agentId, payload: req.body, ts: Date.now() })
  }
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
  try {
    const payload = await enrichMessengerPayloadWithMedia(accId, agentId, req.body)
    pushSSE({ type: 'messenger', accId, agentId, payload, ts: Date.now() })
  } catch (e) {
    console.error('[messengerReceive]', e)
    pushSSE({ type: 'messenger', accId, agentId, payload: req.body, ts: Date.now() })
  }
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
  try {
    const payload = await enrichInstagramPayloadWithMedia(accId, agentId, req.body)
    pushSSE({ type: 'instagram', accId, agentId, payload, ts: Date.now() })
  } catch (e) {
    console.error('[instagramReceive]', e)
    pushSSE({ type: 'instagram', accId, agentId, payload: req.body, ts: Date.now() })
  }
}

// ── SSE stream ────────────────────────────────────────────────────────────────

const sseStream = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n') } catch { clearInterval(hb) } }, 20000)
  messageQueue.slice(-10).forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`))
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
  pushSSE({ type, accId, agentId, payload, ts: Date.now() })
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
