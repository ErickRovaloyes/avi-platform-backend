const express = require('express')
const cors = require('cors')
const app = express()

app.use(cors({ origin: '*' }))
app.use(express.json())

const messageQueue = []
const sseClients = new Set()

function pushToSSE(event) {
  messageQueue.push(event)
  if (messageQueue.length > 50) messageQueue.shift()
  const data = `data: ${JSON.stringify(event)}\n\n`
  let sent = 0
  sseClients.forEach(client => {
    try { client.write(data); sent++ } catch { sseClients.delete(client) }
  })
  return sent
}

// ── WhatsApp Verification ─────────────────────────────────────────────────────
app.get('/api/webhook/whatsapp/:accId/:agentId', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  console.log(`[WA-Verify] mode=${mode} token=${token}`)
  if (mode === 'subscribe') { console.log('[WA-Verify] ✓ OK'); return res.status(200).send(challenge) }
  res.sendStatus(403)
})

// ── WhatsApp Incoming messages ────────────────────────────────────────────────
app.post('/api/webhook/whatsapp/:accId/:agentId', (req, res) => {
  const { accId, agentId } = req.params
  const body = req.body
  console.log(`\n[WA-POST] acc:${accId} agent:${agentId}`)
  const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages || []
  if (messages.length === 0) { console.log('[WA-POST] Sin mensajes (status update)'); return res.sendStatus(200) }
  const sent = pushToSSE({ type: 'whatsapp', accId, agentId, payload: body, ts: Date.now() })
  console.log(`[WA-POST] ${messages.length} mensaje(s) → ${sent} cliente(s) SSE`)
  res.sendStatus(200)
})

// ── Messenger Verification ────────────────────────────────────────────────────
app.get('/api/webhook/messenger/:accId/:agentId', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  console.log(`[FB-Verify] mode=${mode} token=${token}`)
  if (mode === 'subscribe') { console.log('[FB-Verify] ✓ OK'); return res.status(200).send(challenge) }
  res.sendStatus(403)
})

// ── Messenger Incoming messages ───────────────────────────────────────────────
app.post('/api/webhook/messenger/:accId/:agentId', (req, res) => {
  const { accId, agentId } = req.params
  const body = req.body
  if (body?.object !== 'page') return res.sendStatus(200)
  console.log(`\n[FB-POST] acc:${accId} agent:${agentId}`)
  const entries = body?.entry || []
  let msgCount = 0
  entries.forEach(e => { msgCount += (e.messaging || []).filter(m => m.message?.text).length })
  if (msgCount === 0) { console.log('[FB-POST] Sin mensajes de texto'); return res.sendStatus(200) }
  const sent = pushToSSE({ type: 'messenger', accId, agentId, payload: body, ts: Date.now() })
  console.log(`[FB-POST] ${msgCount} mensaje(s) → ${sent} cliente(s) SSE`)
  res.sendStatus(200)
})

// ── Instagram Verification ────────────────────────────────────────────────────
app.get('/api/webhook/instagram/:accId/:agentId', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  console.log(`[IG-Verify] mode=${mode} token=${token}`)
  if (mode === 'subscribe') { console.log('[IG-Verify] ✓ OK'); return res.status(200).send(challenge) }
  res.sendStatus(403)
})

// ── Instagram Incoming messages ───────────────────────────────────────────────
app.post('/api/webhook/instagram/:accId/:agentId', (req, res) => {
  const { accId, agentId } = req.params
  const body = req.body
  if (body?.object !== 'instagram') return res.sendStatus(200)
  console.log(`\n[IG-POST] acc:${accId} agent:${agentId}`)
  const sent = pushToSSE({ type: 'instagram', accId, agentId, payload: body, ts: Date.now() })
  console.log(`[IG-POST] → ${sent} cliente(s) SSE`)
  res.sendStatus(200)
})

// ── SSE stream ────────────────────────────────────────────────────────────────
app.get('/api/whatsapp/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n') } catch { clearInterval(heartbeat) }
  }, 20000)

  // IMPORTANTE: NO se reenvían eventos al reconectar.
  // Cada evento de webhook dispara efectos reales en el navegador (ejecuta el
  // flujo y ENVÍA respuestas a WhatsApp/Messenger). Reenviar los eventos al
  // reconectar (recarga de página, redeploy del frontend) provocaba que se
  // reprocesaran mensajes antiguos y se reenviaran respuestas ya entregadas.
  // Un mensaje perdido durante una desconexión breve es preferible a reenviar
  // respuestas a clientes reales.

  sseClients.add(res)
  console.log(`[SSE] +1 cliente (total: ${sseClients.size})`)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(res)
    console.log(`[SSE] -1 cliente (total: ${sseClients.size})`)
  })
})

// ── Manual test: inject fake messages ────────────────────────────────────────
app.post('/test-message', (req, res) => {
  const { accId, agentId, phoneNumberId, from, text, fromName, channel = 'whatsapp' } = req.body
  let payload, type

  if (channel === 'messenger') {
    type = 'messenger'
    payload = {
      object: 'page',
      entry: [{ id: phoneNumberId || 'page_test', messaging: [{ sender: { id: from }, recipient: { id: phoneNumberId }, timestamp: Date.now(), message: { mid: 'test_' + Date.now(), text } }] }]
    }
  } else if (channel === 'instagram') {
    type = 'instagram'
    payload = {
      object: 'instagram',
      entry: [{ id: phoneNumberId || 'ig_test', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from, profile: { name: fromName || 'Test' } }], messages: [{ id: 'test_' + Date.now(), from, type: 'text', timestamp: String(Date.now()), text: { body: text } }] } }] }]
    }
  } else {
    type = 'whatsapp'
    payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'test', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId, display_phone_number: 'TEST' }, contacts: [{ wa_id: from, profile: { name: fromName || 'Test User' } }], messages: [{ id: 'test_' + Date.now(), from, type: 'text', timestamp: String(Date.now()), text: { body: text } }] } }] }]
    }
  }

  const sent = pushToSSE({ type, accId, agentId, payload, ts: Date.now() })
  console.log(`[TEST] Mensaje de prueba (${channel}) → ${sent} cliente(s) SSE`)
  res.json({ ok: true, channel, sseClientsSent: sent })
})

app.get('/debug', (req, res) => {
  res.json({
    sseClients: sseClients.size,
    queueLength: messageQueue.length,
    lastEvents: messageQueue.slice(-5).map(e => ({
      type: e.type, ts: new Date(e.ts).toISOString(), accId: e.accId, agentId: e.agentId,
    }))
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', sseClients: sseClients.size, queue: messageQueue.length })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`)
  console.log(`║  AVI Webhook Server — puerto ${PORT}                        ║`)
  console.log(`║  WhatsApp:  /api/webhook/whatsapp/:accId/:agentId         ║`)
  console.log(`║  Messenger: /api/webhook/messenger/:accId/:agentId        ║`)
  console.log(`║  Instagram: /api/webhook/instagram/:accId/:agentId        ║`)
  console.log(`║  SSE:       /api/whatsapp/events                          ║`)
  console.log(`║  Debug:     http://localhost:${PORT}/debug                  ║`)
  console.log(`╚══════════════════════════════════════════════════════════╝\n`)
})
