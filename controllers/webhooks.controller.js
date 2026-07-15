'use strict'
const pool = require('../db')
const { parseJ } = require('../utils')
const { storeMediaInternal } = require('./media.controller')
const { downloadWhatsAppMedia, downloadFromUrl } = require('../services/metaMedia')
const flow = require('../flow/process')
const flowStore = require('../flow/store')
const waHistorySync = require('../services/waHistorySync')

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

// Procesa UNA entry del webhook de WhatsApp para una cuenta/agente concretos.
// Reutilizable por el webhook POR CUENTA (URL con :accId/:agentId) y por el
// webhook GLOBAL de la app de Coexistencia (que resuelve la cuenta por número).
const onlyDigits = s => String(s || '').replace(/\D/g, '')

// Mensajes ENTRANTES del cliente (vengan por `messages` o como parte de un eco de
// coexistencia): guarda + corre el flujo + abre la ventana de 24h + muestra en
// tiempo real. `value` debe traer metadata + messages (+ contacts opcional).
async function ingestInboundMessages(accId, agentId, value, contacts) {
  const messages = value?.messages || []
  if (!messages.length) return
  console.log(`[WA in] ${accId}/${agentId} · ${messages.length} entrante(s) de ${messages.map(m => m.from).join(', ')}`)
  const entry = { changes: [{ field: 'messages', value: { ...value, messages, contacts: contacts || value?.contacts || [] } }] }
  let payload = { object: 'whatsapp_business_account', entry: [entry] }
  try { payload = await enrichWhatsAppPayloadWithMedia(accId, agentId, payload) }
  catch (e) { console.error('[whatsappReceive] media enrich', e) }
  pushSSE({ type: 'whatsapp', accId, agentId, ts: Date.now() })
  flow.processWhatsApp(accId, agentId, payload).catch(e => console.error('[flow WA]', e))
}

// Procesa UN change del webhook.
async function processWhatsAppChange(accId, agentId, change) {
  const field = change?.field || 'messages'
  const value = change?.value || {}

  // Historial (backfill) y sync de contactos → servicio de coexistencia (sin IA).
  if (field === 'history' || field === 'smb_app_state_sync') {
    waHistorySync.ingestCoexistenceChange(accId, agentId, field, value)
      .catch(e => console.error('[WA coexistence sync]', e.message))
    return
  }

  // Ecos del móvil (coexistencia): pueden traer SALIENTES (del negocio) y —según
  // cómo Meta entregue en coexistencia— también ENTRANTES del cliente. Se separan
  // por dirección: los del negocio se guardan como eco; los del cliente van al
  // camino normal de entrada (para que se muestren, abran la ventana de 24h y, si
  // corresponde, respondan). Antes TODO se guardaba como saliente → los mensajes
  // del cliente no aparecían.
  if (field === 'smb_message_echoes') {
    const bizNum = onlyDigits(value?.metadata?.display_phone_number)
    const list = value?.message_echoes || value?.messages || []
    const outbound = [], inbound = []
    for (const m of list) {
      const fromBiz = bizNum && onlyDigits(m?.from) === bizNum
      ;(fromBiz ? outbound : inbound).push(m)
    }
    console.log(`[WA coex] ${accId}/${agentId} echoes: ${outbound.length} salientes · ${inbound.length} entrantes`)
    if (outbound.length) {
      waHistorySync.ingestCoexistenceChange(accId, agentId, 'smb_message_echoes', { ...value, message_echoes: outbound })
        .catch(e => console.error('[WA coexistence sync]', e.message))
    }
    if (inbound.length) await ingestInboundMessages(accId, agentId, { ...value, messages: inbound })
    return
  }

  // Camino normal: mensajes entrantes + acuses de estado.
  const msgs = value.messages || []
  const statuses = value.statuses || []
  if (!msgs.length && statuses.length) {
    for (const st of statuses) flowStore.updateMessageStatus(st.id, st.status).catch(e => console.error('[WA status]', e.message))
    return
  }
  if (!msgs.length) return
  await ingestInboundMessages(accId, agentId, value)
}

// Procesa TODOS los changes de una entry (Meta puede mandar varios por entry).
async function processWhatsAppEntry(accId, agentId, entry) {
  for (const change of (entry?.changes || [])) {
    try { await processWhatsAppChange(accId, agentId, change) }
    catch (e) { console.error('[WA change]', change?.field, e.message) }
  }
}

// Busca a qué cuenta/agente pertenece un número (webhook GLOBAL de Coexistencia).
// Match por phone_number_id y, como FALLBACK, por el número visible: en
// coexistencia el phone_number_id del webhook entrante a veces NO coincide con el
// que devolvió el Embedded Signup, y así los mensajes entrantes se perdían.
async function findAgentByPhoneNumberId(pnid, displayPhone) {
  const dp = String(displayPhone || '').replace(/\D/g, '')
  try {
    const [rows] = await pool.query("SELECT id, account_id, channels FROM agents WHERE channels LIKE '%\"whatsapp\"%'")
    const stored = []
    // 1) por phone_number_id exacto
    for (const r of rows) {
      for (const c of parseJ(r.channels, [])) {
        if (c.type !== 'whatsapp' || !c.config) continue
        if (c.config.phoneNumberId) stored.push(`${c.config.phoneNumberId}${c.config.displayPhone ? '(' + c.config.displayPhone + ')' : ''}`)
        if (pnid && String(c.config.phoneNumberId) === String(pnid)) return { accId: r.account_id, agentId: r.id }
      }
    }
    // 2) fallback: por número visible (dígitos)
    if (dp) for (const r of rows) {
      for (const c of parseJ(r.channels, [])) {
        if (c.type !== 'whatsapp' || !c.config) continue
        if (String(c.config.displayPhone || '').replace(/\D/g, '') === dp) {
          console.log(`[findAgent] match por número visible (${displayPhone}) — pnid del webhook ${pnid} no coincidía con el guardado`)
          return { accId: r.account_id, agentId: r.id }
        }
      }
    }
    console.warn(`[findAgent] SIN match · pnid=${pnid} display=${displayPhone} · registrados: ${stored.join(', ') || '(ninguno)'}`)
  } catch (e) { console.error('[findAgentByPhoneNumberId]', e.message) }
  return null
}

const whatsappReceive = async (req, res) => {
  const { accId, agentId } = req.params
  // ACK inmediato a Meta; el resto va en segundo plano.
  res.sendStatus(200)
  for (const entry of (req.body?.entry || [])) {
    processWhatsAppEntry(accId, agentId, entry).catch(e => console.error('[WA entry]', e.message))
  }
}

// Webhook GLOBAL de la app de Coexistencia: Meta envía TODOS los mensajes de
// todos los clientes a una sola URL. Aquí resolvemos la cuenta/agente por el
// phone_number_id de cada entry y procesamos como el webhook por cuenta.
const whatsappReceiveGlobal = async (req, res) => {
  res.sendStatus(200)
  for (const entry of (req.body?.entry || [])) {
    try {
      const changes = entry?.changes || []
      const meta0 = changes[0]?.value?.metadata || {}
      const pnid = meta0.phone_number_id
      const displayPhone = meta0.display_phone_number
      const fields = changes.map(c => c.field).join(',') || '(sin changes)'
      const target = await findAgentByPhoneNumberId(pnid, displayPhone)
      if (!target) { console.warn(`[WA global] sin agente · pnid=${pnid} display=${displayPhone} — fields: ${fields}`); continue }
      console.log(`[WA global] pnid=${pnid} → ${target.accId}/${target.agentId} · fields=[${fields}]`)
      await processWhatsAppEntry(target.accId, target.agentId, entry)
    } catch (e) { console.error('[WA global entry]', e.message) }
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
  whatsappVerify, whatsappReceive, whatsappReceiveGlobal,
  messengerVerify, messengerReceive,
  instagramVerify, instagramReceive,
  sseStream, testMessage, getDebug, getHealth,
}
