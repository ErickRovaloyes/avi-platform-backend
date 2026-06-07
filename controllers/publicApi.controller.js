'use strict'
/**
 * Public API v1 — endpoints exposed to external systems (N8N, Zapier, etc.)
 * via the X-AVI-Key authentication scheme.
 *
 * Every handler in here trusts req.user.accountId from the API key auth and
 * delegates to existing internal controllers — no duplicated business logic.
 *
 * Convention: keep responses minimal and stable; this is a public contract.
 */

const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// ── POST /api/v1/messages ───────────────────────────────────────────────────
// Body: { conversationId, content, senderName? }
// Inserts a 'human' (asesor) message into a conversation.
const sendMessage = async (req, res) => {
  const { conversationId, content, senderName } = req.body || {}
  if (!conversationId || !content) return res.status(400).json({ error: 'conversationId y content requeridos' })
  const accId = req.user.accountId
  try {
    // Validate the conversation belongs to the caller's account.
    const [[c]] = await pool.query(
      'SELECT account_id, agent_id FROM conversations WHERE id=? AND account_id=?',
      [conversationId, accId]
    )
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada' })

    const id = 'msg_' + uid()
    const ts = Date.now()
    const metadata = { senderName: senderName || 'API' }
    await pool.query(
      'INSERT INTO messages (id, conversation_id, sender, content, metadata, ts) VALUES (?,?,?,?,?,?)',
      [id, conversationId, 'human', content, JSON.stringify(metadata), ts]
    )
    // Bump conversation preview + updated_at (same as appendMessage in conversations.controller)
    await pool.query(
      'UPDATE conversations SET preview=?, updated_at=? WHERE id=? AND account_id=?',
      [(content || '').slice(0, 60), ts, conversationId, accId]
    )

    const msg = { id, sender: 'human', content, ts, ...metadata }
    socket.emit(accId, 'message:new', { accId, agId: c.agent_id, convId: conversationId, message: msg })
    socket.emitToConv(conversationId, 'message:new', { convId: conversationId, message: msg })

    res.json({ id, ts })
  } catch (err) { console.error('[v1 sendMessage]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── POST /api/v1/contacts ───────────────────────────────────────────────────
// Body: { name, email?, phone?, ...customFields }
// Creates a contact. Pairs naturally with the contacts.controller schema (extra JSON).
const upsertContact = async (req, res) => {
  const { name = '', email = '', phone = '', ...extra } = req.body || {}
  if (!name && !email && !phone) return res.status(400).json({ error: 'Al menos uno: name, email o phone' })
  const accId = req.user.accountId
  try {
    const id = 'contact_' + uid()
    await pool.query(
      'INSERT INTO contacts (id, account_id, name, email, phone, extra, created_at) VALUES (?,?,?,?,?,?,?)',
      [id, accId, name, email, phone, JSON.stringify(extra || {}), Date.now()]
    )
    res.json({ id })
  } catch (err) { console.error('[v1 upsertContact]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── POST /api/v1/crm/tasks ──────────────────────────────────────────────────
// Body: { title, description?, dueAt?, targetType?, targetId?, priority? }
const createTask = async (req, res) => {
  const { title = '', description = '', dueAt = null, targetType = null, targetId = null, priority = 'normal', assigneeName = '' } = req.body || {}
  if (!title.trim()) return res.status(400).json({ error: 'title requerido' })
  const accId = req.user.accountId
  try {
    const id = 'task_' + uid()
    await pool.query(
      `INSERT INTO crm_tasks (id, account_id, target_type, target_id, title, description, due_at, assignee_name, status, priority, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, accId, targetType, targetId, title.trim(), description, dueAt, assigneeName, 'open', priority, 'API', Date.now()]
    )
    res.json({ id })
  } catch (err) { console.error('[v1 createTask]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── POST /api/v1/crm/notes ──────────────────────────────────────────────────
// Body: { targetType, targetId, content }
const createNote = async (req, res) => {
  const { targetType, targetId, content = '' } = req.body || {}
  if (!targetType || !targetId || !content.trim()) return res.status(400).json({ error: 'targetType, targetId y content requeridos' })
  const accId = req.user.accountId
  try {
    const id = 'note_' + uid()
    await pool.query(
      'INSERT INTO crm_notes (id, account_id, target_type, target_id, author_name, content, ts) VALUES (?,?,?,?,?,?,?)',
      [id, accId, targetType, targetId, 'API', content, Date.now()]
    )
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── PUT /api/v1/conversations/:id/assign ────────────────────────────────────
// Body: { assigneeId, assigneeName } or { assigneeName } (no validation against members)
const assignConversation = async (req, res) => {
  const { id } = req.params
  const { assigneeId = null, assigneeName = '' } = req.body || {}
  const accId = req.user.accountId
  try {
    const [[c]] = await pool.query('SELECT agent_id FROM conversations WHERE id=? AND account_id=?', [id, accId])
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada' })
    const assignee = assigneeName ? { id: assigneeId, name: assigneeName } : null
    await pool.query('UPDATE conversations SET assigned_to=? WHERE id=? AND account_id=?',
      [assignee ? JSON.stringify(assignee) : null, id, accId])
    socket.emit(accId, 'convos:updated', { accId, agId: c.agent_id })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── GET /api/v1/conversations ───────────────────────────────────────────────
// Lightweight listing — useful for n8n to look up which conversation to message.
const listConversations = async (req, res) => {
  const accId = req.user.accountId
  const { limit = 50, channel, search } = req.query
  try {
    const where = ['account_id=?']; const params = [accId]
    if (channel) { where.push('channel_type=?'); params.push(channel) }
    if (search)  {
      where.push('(guest_name LIKE ? OR wa_from LIKE ? OR messenger_from LIKE ? OR ig_from LIKE ?)')
      const q = `%${search}%`; params.push(q, q, q, q)
    }
    const [rows] = await pool.query(
      `SELECT id, agent_id, channel_type, guest_name, wa_from, messenger_from, ig_from, preview, updated_at, ai_enabled, assigned_to
       FROM conversations
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      [...params, Math.min(parseInt(limit) || 50, 200)]
    )
    res.json(rows.map(c => ({
      id: c.id, agentId: c.agent_id, channel: c.channel_type,
      guestName: c.guest_name, waFrom: c.wa_from, messengerFrom: c.messenger_from, igFrom: c.ig_from,
      preview: c.preview, updatedAt: c.updated_at,
      aiEnabled: !!c.ai_enabled, assignedTo: parseJ(c.assigned_to, null),
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── GET /api/v1/me ──────────────────────────────────────────────────────────
// Lets the API key holder verify auth + see the granted scopes.
const me = async (req, res) => {
  res.json({
    type: 'api_key',
    accountId: req.user.accountId,
    apiKeyId: req.user.apiKeyId,
    scopes: req.user.scopes || [],
    ts: Date.now(),
  })
}

module.exports = { sendMessage, upsertContact, createTask, createNote, assignConversation, listConversations, me }
