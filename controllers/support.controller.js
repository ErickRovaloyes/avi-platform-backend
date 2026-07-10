'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

const getAllTickets = async (req, res) => {
  try {
    // Solo el super admin (panel) ve TODOS los tickets. Un usuario de cuenta (o el super
    // admin en modo vista) solo ve los tickets de SU cuenta — así no recibe las
    // calificaciones ni tickets de otras cuentas/asesores.
    const isSA = req.user?.type === 'superadmin'
    let tickets
    if (isSA) {
      [tickets] = await pool.query('SELECT * FROM support_tickets ORDER BY updated_at DESC')
    } else {
      const accId = req.user?.accountId
      if (!accId) return res.json([])
      ;[tickets] = await pool.query('SELECT * FROM support_tickets WHERE account_id=? ORDER BY updated_at DESC', [accId])
    }
    const ids = tickets.map(t => t.id)
    const messages = ids.length
      ? (await pool.query(`SELECT * FROM support_messages WHERE ticket_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts ASC`, ids))[0]
      : []
    res.json(tickets.map(t => ({
      id: t.id, accId: t.account_id, accountName: t.account_name,
      subject: t.subject, status: t.status, assignedTo: parseJ(t.assigned_to, null),
      refs: parseJ(t.refs, []),
      rating: t.rating != null ? Number(t.rating) : null, ratingNote: t.rating_note || '', ratedAt: t.rated_at || null,
      messages: messages.filter(m => m.ticket_id === t.id).map(m => ({
        id: m.id, role: m.role, authorId: m.author_id, authorName: m.author_name,
        content: m.content, ts: m.ts, media: parseJ(m.media, null),
      })),
      createdAt: t.created_at, updatedAt: t.updated_at,
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Build a short text preview for a message (handles media-only messages)
function previewOf(content, media) {
  if (content && content.trim()) return content.slice(0, 60)
  if (media) {
    const icon = media.kind === 'image' ? '🖼 Imagen' : media.kind === 'video' ? '🎬 Video' : media.kind === 'audio' ? '🎤 Audio' : '📎 Archivo'
    return icon
  }
  return ''
}

const createTicket = async (req, res) => {
  const { accId, accountName, subject, message, authorId, authorName, media = null, refs = [] } = req.body
  const ticketId = 'tkt_' + uid()
  const msgId    = 'msg_' + uid()
  const ts       = Date.now()
  try {
    await pool.query(
      'INSERT INTO support_tickets (id,account_id,account_name,subject,status,assigned_to,refs,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [ticketId, accId, accountName, subject || 'Soporte', 'open', null, JSON.stringify(Array.isArray(refs) ? refs : []), ts, ts]
    )
    await pool.query(
      'INSERT INTO support_messages (id,ticket_id,role,author_id,author_name,content,ts,media) VALUES (?,?,?,?,?,?,?,?)',
      [msgId, ticketId, 'user', authorId, authorName, message, ts, media ? JSON.stringify(media) : null]
    )
    socket.broadcast('support:updated', { accId, lastRole: 'user', preview: previewOf(message, media) })
    res.json({ id: ticketId })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const addMessage = async (req, res) => {
  const { ticketId } = req.params
  const { role, authorId, authorName, content, media = null } = req.body
  const id = 'msg_' + uid()
  const ts = Date.now()
  try {
    await pool.query(
      'INSERT INTO support_messages (id,ticket_id,role,author_id,author_name,content,ts,media) VALUES (?,?,?,?,?,?,?,?)',
      [id, ticketId, role, authorId, authorName, content, ts, media ? JSON.stringify(media) : null]
    )
    // Get the ticket's accId for targeted emit
    const [[tkt]] = await pool.query('SELECT account_id FROM support_tickets WHERE id=?', [ticketId])
    if (role === 'support') {
      await pool.query('UPDATE support_tickets SET status="in_progress",updated_at=? WHERE id=?', [ts, ticketId])
    } else {
      await pool.query('UPDATE support_tickets SET updated_at=? WHERE id=?', [ts, ticketId])
    }
    socket.broadcast('support:updated', { accId: tkt?.account_id, lastRole: role, preview: previewOf(content, media) })
    res.json({ id, ts })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateTicket = async (req, res) => {
  const { ticketId } = req.params
  const { status, assignedTo, refs } = req.body
  try {
    const [[tkt]] = await pool.query('SELECT account_id FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    const sets = ['updated_at=?']; const vals = [Date.now()]
    if (status     !== undefined) { sets.push('status=?');      vals.push(status) }
    if (assignedTo !== undefined) { sets.push('assigned_to=?'); vals.push(JSON.stringify(assignedTo)) }
    if (refs       !== undefined) { sets.push('refs=?');        vals.push(JSON.stringify(Array.isArray(refs) ? refs : [])) }
    vals.push(ticketId)
    await pool.query(`UPDATE support_tickets SET ${sets.join(',')} WHERE id=?`, vals)
    socket.broadcast('support:updated', { accId: tkt.account_id })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateStatus = async (req, res) => {
  const { ticketId } = req.params
  const { status } = req.body
  try {
    const [[tkt]] = await pool.query('SELECT account_id FROM support_tickets WHERE id=?', [ticketId])
    await pool.query('UPDATE support_tickets SET status=?,updated_at=? WHERE id=?', [status, Date.now(), ticketId])
    socket.broadcast('support:updated', { accId: tkt?.account_id })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const assignTicket = async (req, res) => {
  const { ticketId } = req.params
  const { saId, saName } = req.body
  try {
    const [[tkt]] = await pool.query('SELECT account_id FROM support_tickets WHERE id=?', [ticketId])
    await pool.query('UPDATE support_tickets SET assigned_to=?,updated_at=? WHERE id=?', [JSON.stringify({ saId, saName }), Date.now(), ticketId])
    socket.broadcast('support:updated', { accId: tkt?.account_id })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Calificación (1-10) + nota que deja quien creó el ticket, una vez cerrado.
const submitRating = async (req, res) => {
  const { ticketId } = req.params
  const rating = Math.round(Number(req.body?.rating))
  const note = String(req.body?.note || '').slice(0, 1000)
  if (!Number.isFinite(rating) || rating < 1 || rating > 10) return res.status(400).json({ error: 'La calificación debe ser del 1 al 10.' })
  try {
    const [[tkt]] = await pool.query('SELECT account_id, status, rating FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    // Solo quien pertenece a la cuenta del ticket puede calificar (no el soporte/super admin).
    if (req.user?.type !== 'superadmin' && req.user?.accountId && req.user.accountId !== tkt.account_id) {
      return res.status(403).json({ error: 'No puedes calificar este ticket.' })
    }
    if (tkt.status !== 'closed') return res.status(400).json({ error: 'Solo puedes calificar un ticket cerrado.' })
    await pool.query('UPDATE support_tickets SET rating=?, rating_note=?, rated_at=?, updated_at=? WHERE id=?',
      [rating, note, Date.now(), Date.now(), ticketId])
    socket.broadcast('support:updated', { accId: tkt.account_id })
    res.json({ ok: true })
  } catch (err) { console.error('[support rating]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { getAllTickets, createTicket, addMessage, updateTicket, updateStatus, assignTicket, submitRating }
