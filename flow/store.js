'use strict'
/**
 * Flow store — capa de datos del motor de flujos server-side.
 *
 * Reemplaza al storage.js del navegador: en vez de hacer llamadas HTTP a la API,
 * accede a la base de datos directamente y emite los MISMOS eventos socket.io
 * (message:new, convos:updated) que emiten los controllers, para que la UI se
 * actualice en tiempo real exactamente igual que antes.
 */

const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')
const { loadPublicAccount } = require('../controllers/accounts.controller')
const { createOrGetSocialConvo } = require('../controllers/conversations.controller')
const { recordUsageInternal } = require('../controllers/analytics.controller')

const mapConvo = (c, messages = []) => ({
  id: c.id, guestName: c.guest_name, guestId: c.guest_id,
  channelId: c.channel_id, linkId: c.channel_id, channel: c.channel_type,
  waFrom: c.wa_from, messengerFrom: c.messenger_from, igFrom: c.ig_from,
  initials: c.initials, preview: c.preview,
  unread: !!c.unread, aiEnabled: !!c.ai_enabled,
  labels:        parseJ(c.labels, []),
  pipelineCards: parseJ(c.pipeline_cards, []),
  localVars:     parseJ(c.local_vars, {}),
  debugLog:      parseJ(c.debug_log, []),
  assignedTo:    parseJ(c.assigned_to, null),
  messages,
  createdAt: c.created_at, updatedAt: c.updated_at,
})

// ── Account ──────────────────────────────────────────────────────────────────
async function loadAccount(accId) {
  return loadPublicAccount(accId)
}

// ── Conversations read ──────────────────────────────────────────────────────
async function readConvos(accId, agId) {
  // Sin ORDER BY en SQL: ordenar SELECT * con columnas JSON dispara un filesort de
  // filas anchas que agota el sort_buffer en MySQL 8. Se ordena en JS.
  const [rows] = await pool.query('SELECT * FROM conversations WHERE account_id=? AND agent_id=?', [accId, agId])
  if (rows.length === 0) return []
  rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
  const convIds = rows.map(c => c.id)
  const [msgs] = await pool.query('SELECT * FROM messages WHERE conversation_id IN (?)', [convIds])
  msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  const byConv = {}
  for (const m of msgs) {
    (byConv[m.conversation_id] ||= []).push({ id: m.id, sender: m.sender, content: m.content, ts: m.ts, ...parseJ(m.metadata, {}) })
  }
  return rows.map(c => mapConvo(c, byConv[c.id] || []))
}

// ── Idempotencia: ¿ya existe un mensaje con este id de proveedor? ───────────
// Defensa persistente (sobrevive reinicios del backend) contra reprocesar el
// mismo webhook. Busca por waMessageId (WhatsApp) o providerMsgId (FB/IG).
async function messageExistsByProviderId(convId, providerId) {
  if (!convId || !providerId) return false
  try {
    const [rows] = await pool.query(
      `SELECT id FROM messages
       WHERE conversation_id=?
         AND (JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.waMessageId'))=?
           OR JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.providerMsgId'))=?)
       LIMIT 1`,
      [convId, String(providerId), String(providerId)]
    )
    return rows.length > 0
  } catch { return false }
}

// ── Append message (mirrors conversations.controller.appendMessage) ─────────
async function appendMsg(accId, agId, convId, msg) {
  const { sender, content, ...rest } = msg
  const id = 'msg_' + uid()
  const ts = Date.now()
  const metadata = Object.keys(rest).length ? rest : null
  await pool.query('INSERT INTO messages (id,conversation_id,sender,content,metadata,ts) VALUES (?,?,?,?,?,?)',
    [id, convId, sender, content, metadata ? JSON.stringify(metadata) : null, ts])
  const sets = ['preview=?', 'updated_at=?']
  const vals = [(content || '').slice(0, 60), ts]
  if (sender === 'user') sets.push('unread=1')
  vals.push(convId, accId)
  await pool.query(`UPDATE conversations SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)

  if (sender === 'user' && content) {
    try {
      const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
      const lv = parseJ(c?.local_vars, {})
      lv._lastUserMessage = content
      await pool.query('UPDATE conversations SET local_vars=? WHERE id=? AND account_id=?', [JSON.stringify(lv), convId, accId])
    } catch { /* non-critical */ }
  }

  const out = { id, sender, content, ts, ...rest }
  socket.emit(accId, 'message:new', { accId, agId, convId, message: out })
  socket.emitToConv(convId, 'message:new', { convId, message: out })
  return { id, ts }
}

// ── Estado de entrega de un mensaje saliente (sent/delivered/read/failed) ───
// Mapea el id de proveedor (wamid) al mensaje y actualiza su estado sin
// degradarlo (read > delivered > sent). Emite message:status para la UI.
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 }
async function updateMessageStatus(wamid, status) {
  if (!wamid || !status) return
  const [[m]] = await pool.query(
    "SELECT id, conversation_id, metadata FROM messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.waMessageId'))=? LIMIT 1",
    [String(wamid)]
  )
  if (!m) return
  const meta = parseJ(m.metadata, {})
  // No degradar el estado (un 'delivered' tardío no debe pisar un 'read')
  if (status !== 'failed' && (STATUS_RANK[status] || 0) <= (STATUS_RANK[meta.status] || 0)) return
  meta.status = status
  await pool.query('UPDATE messages SET metadata=? WHERE id=?', [JSON.stringify(meta), m.id])
  const [[c]] = await pool.query('SELECT account_id, agent_id FROM conversations WHERE id=?', [m.conversation_id])
  if (c) {
    socket.emit(c.account_id, 'message:status', { accId: c.account_id, agId: c.agent_id, convId: m.conversation_id, messageId: m.id, status })
    socket.emitToConv(m.conversation_id, 'message:status', { convId: m.conversation_id, messageId: m.id, status })
  }
}

// ── Update conversation (labels, ai toggle, flowRunning, assignedTo, etc) ───
async function updateConvo(accId, agId, convId, updates) {
  // NB: flowRunning is handled in-memory by the engine (no DB column), so it's
  // intentionally not mapped here — passing it through is a harmless no-op.
  const map = { guestName:'guest_name', preview:'preview', unread:'unread', aiEnabled:'ai_enabled', labels:'labels', pipelineCards:'pipeline_cards', localVars:'local_vars', debugLog:'debug_log', assignedTo:'assigned_to' }
  const sets = []; const vals = []
  for (const [key, col] of Object.entries(map)) {
    if (updates[key] !== undefined) {
      sets.push(`${col}=?`)
      const v = updates[key]
      vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
    }
  }
  if (sets.length === 0) return
  vals.push(convId, accId)
  await pool.query(`UPDATE conversations SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
  socket.emit(accId, 'convos:updated', { accId, agId })
}

// ── Local variable patch ────────────────────────────────────────────────────
async function setLocalVar(accId, agId, convId, varId, value) {
  const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
  if (!c) return
  const vars = parseJ(c.local_vars, {})
  vars[varId] = value
  await pool.query('UPDATE conversations SET local_vars=? WHERE id=?', [JSON.stringify(vars), convId])
  socket.emit(accId, 'convos:updated', { accId, agId })
}

// ── Debug log append (non-critical) ─────────────────────────────────────────
async function appendDebugEntry(accId, agId, convId, entry) {
  try {
    const [[c]] = await pool.query('SELECT debug_log FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    const log = parseJ(c?.debug_log, [])
    log.push({ ...entry, ts: Date.now() })
    await pool.query('UPDATE conversations SET debug_log=? WHERE id=? AND account_id=?', [JSON.stringify(log), convId, accId])
  } catch { /* non-critical */ }
  // Registro de errores global: cualquier entrada de tipo error queda en error_log
  if (entry?.type === 'error') {
    try {
      const detail = entry.detail ? (typeof entry.detail === 'object' ? JSON.stringify(entry.detail) : String(entry.detail)) : null
      await pool.query(
        'INSERT INTO error_log (account_id, agent_id, conv_id, source, message, detail, ts) VALUES (?,?,?,?,?,?,?)',
        [accId, agId, convId, 'flow', String(entry.title || '').slice(0, 500), detail ? detail.slice(0, 1000) : null, Date.now()]
      )
    } catch { /* non-critical */ }
  }
}

// Persiste una ejecución de flujo (chat real o prueba) para el log global.
async function saveExecution({ accId, agId, convId, flowId, flowName, trigger, status, error, durationMs, startedAt, source = 'chat' }) {
  try {
    await pool.query(
      `INSERT INTO flow_executions (account_id, agent_id, conv_id, flow_id, flow_name, trigger_type, status, error, duration_ms, started_at, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [accId, agId || null, convId || null, flowId || null, flowName || '', trigger || '', status || 'success', error ? String(error).slice(0, 1000) : null, durationMs || 0, startedAt || Date.now(), source]
    )
  } catch (e) { console.warn('[saveExecution]', e.message) }
}

// ── Social create-or-get (delegates to controller core) ─────────────────────
async function createOrGetWhatsAppConvo(accId, agentId, from, name, channelId) {
  return createOrGetSocialConvo(accId, agentId, 'wa_from', from, name || `WA #${(from || '').slice(-4)}`, 'whatsapp', channelId)
}
async function createOrGetMessengerConvo(accId, agentId, from, name, channelId) {
  return createOrGetSocialConvo(accId, agentId, 'messenger_from', from, name || `FB #${(from || '').slice(-4)}`, 'messenger', channelId)
}
async function createOrGetInstagramConvo(accId, agentId, from, name, channelId) {
  return createOrGetSocialConvo(accId, agentId, 'ig_from', from, name || `IG #${(from || '').slice(-4)}`, 'instagram', channelId)
}

// ── Token usage ─────────────────────────────────────────────────────────────
function recordTokenUsage(accId, { agentId, conversationId, provider, model, promptTokens, completionTokens, source }) {
  return recordUsageInternal({ accId, agentId, conversationId, provider, model, promptTokens, completionTokens, source }).catch(() => {})
}

// Resuelve un mensaje por su id de proveedor (wamid / providerMsgId) → contenido
// legible. Lo usa la función de "responder/citar": cuando el cliente cita un
// mensaje anterior, recuperamos su texto para dárselo de contexto al asistente.
async function getMessageByProviderId(convId, providerId) {
  if (!convId || !providerId) return null
  try {
    const [rows] = await pool.query(
      `SELECT id, sender, content, metadata FROM messages
       WHERE conversation_id=?
         AND (JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.waMessageId'))=?
           OR JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.providerMsgId'))=?)
       ORDER BY ts DESC LIMIT 1`,
      [convId, String(providerId), String(providerId)]
    )
    const m = rows[0]
    if (!m) return null
    const meta = parseJ(m.metadata, {})
    let content = m.content || ''
    if (!content && meta.kind) content = `[${meta.kind}${meta.filename ? ': ' + meta.filename : ''}]`
    return { id: m.id, sender: m.sender, content, kind: meta.kind || null, filename: meta.filename || null }
  } catch { return null }
}

// Lee los bytes de un medio nuestro (tabla media) para subirlos a un canal.
async function getMediaBytes(accId, mediaId) {
  if (!mediaId) return null
  const [[m]] = await pool.query('SELECT mime_type, filename, data_base64 FROM media WHERE id=? AND account_id=?', [mediaId, accId])
  if (!m) return null
  return { buffer: Buffer.from(m.data_base64, 'base64'), mime: m.mime_type || 'application/octet-stream', filename: m.filename || 'file' }
}

module.exports = {
  loadAccount, readConvos, appendMsg, updateConvo, setLocalVar, appendDebugEntry,
  createOrGetWhatsAppConvo, createOrGetMessengerConvo, createOrGetInstagramConvo,
  recordTokenUsage, messageExistsByProviderId, updateMessageStatus,
  saveExecution, getMediaBytes, getMessageByProviderId,
}
