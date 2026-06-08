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
const { callN8N } = require('../services/n8n')

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
  const [rows] = await pool.query('SELECT * FROM conversations WHERE account_id=? AND agent_id=? ORDER BY updated_at DESC', [accId, agId])
  if (rows.length === 0) return []
  const convIds = rows.map(c => c.id)
  const [msgs] = await pool.query('SELECT * FROM messages WHERE conversation_id IN (?) ORDER BY ts ASC', [convIds])
  const byConv = {}
  for (const m of msgs) {
    (byConv[m.conversation_id] ||= []).push({ id: m.id, sender: m.sender, content: m.content, ts: m.ts, ...parseJ(m.metadata, {}) })
  }
  return rows.map(c => mapConvo(c, byConv[c.id] || []))
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

// ── N8N dispatch ────────────────────────────────────────────────────────────
async function dispatchN8N(integrationId, payload, opts = {}) {
  return callN8N({ integrationId, accountId: payload?._meta?.accountId, payload, forceSync: !!opts.forceSync })
}

module.exports = {
  loadAccount, readConvos, appendMsg, updateConvo, setLocalVar, appendDebugEntry,
  createOrGetWhatsAppConvo, createOrGetMessengerConvo, createOrGetInstagramConvo,
  recordTokenUsage, dispatchN8N,
}
