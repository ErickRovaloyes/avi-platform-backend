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
      takenBy: parseJ(t.taken_by, null), takenAt: t.taken_at || null, priority: t.priority || null,
      eta: t.eta || null, closedAt: t.closed_at || null,
      reported: !!t.reported, reportNote: t.report_note || '', reportedAt: t.reported_at || null, reportedBy: parseJ(t.reported_by, null),
      reportResolved: !!t.report_resolved, reportResolvedAt: t.report_resolved_at || null, reportResolvedBy: parseJ(t.report_resolved_by, null),
      assignHistory: isSA ? parseJ(t.assign_history, []) : [],
      notes: isSA ? parseJ(t.notes, []) : [],   // notas internas: solo para super admins
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

// Round-robin: pre-asigna el ticket al SIGUIENTE super admin después del último asignado.
// Sin estado extra: se basa en el último ticket con asignación. Devuelve {saId,saName} o null.
async function nextRoundRobinAssignee() {
  const [sas] = await pool.query('SELECT id, name FROM super_admins ORDER BY id')
  if (!sas.length) return null
  const [[lastT]] = await pool.query('SELECT assigned_to FROM support_tickets WHERE assigned_to IS NOT NULL ORDER BY created_at DESC LIMIT 1')
  let idx = 0
  if (lastT) {
    const last = parseJ(lastT.assigned_to, null)
    const pos = sas.findIndex(s => s.id === last?.saId)
    idx = pos === -1 ? 0 : (pos + 1) % sas.length
  }
  return { saId: sas[idx].id, saName: sas[idx].name }
}

const createTicket = async (req, res) => {
  const { accId, accountName, subject, message, authorId, authorName, media = null, refs = [] } = req.body
  const ticketId = 'tkt_' + uid()
  const msgId    = 'msg_' + uid()
  const ts       = Date.now()
  try {
    // Pre-asignación round-robin entre los super admins (aún sin "tomar").
    const assignee = await nextRoundRobinAssignee().catch(() => null)
    await pool.query(
      'INSERT INTO support_tickets (id,account_id,account_name,subject,status,assigned_to,refs,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [ticketId, accId, accountName, subject || 'Soporte', 'open', assignee ? JSON.stringify(assignee) : null, JSON.stringify(Array.isArray(refs) ? refs : []), ts, ts]
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
    const [[tkt]] = await pool.query('SELECT account_id, taken_by, assign_history FROM support_tickets WHERE id=?', [ticketId])
    if (role === 'support') {
      // Responder = TOMAR el ticket (si aún no lo tomó nadie): pasa a ser del asesor que responde.
      const alreadyTaken = parseJ(tkt?.taken_by, null)
      if (!alreadyTaken && (authorId || authorName)) {
        const taker = JSON.stringify({ saId: authorId, saName: authorName })
        const hist = histEntry(tkt?.assign_history, { saId: authorId, saName: authorName, action: 'taken', by: { id: authorId, name: authorName } })
        await pool.query('UPDATE support_tickets SET status="in_progress",assigned_to=?,taken_by=?,taken_at=?,assign_history=?,updated_at=? WHERE id=?', [taker, taker, ts, hist, ts, ticketId])
      } else {
        await pool.query('UPDATE support_tickets SET status="in_progress",updated_at=? WHERE id=?', [ts, ticketId])
      }
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
    // Solo un super admin puede cambiar el ESTADO (cerrar / reactivar). El cliente no puede
    // reabrir un ticket cerrado — solo edita cosas propias (p. ej. chats referenciados).
    if (status !== undefined && req.user?.type !== 'superadmin') {
      return res.status(403).json({ error: 'Solo un super admin puede cambiar el estado del ticket.' })
    }
    if (assignedTo !== undefined && req.user?.type !== 'superadmin') {
      return res.status(403).json({ error: 'Solo un super admin puede reasignar el ticket.' })
    }
    const sets = ['updated_at=?']; const vals = [Date.now()]
    if (status     !== undefined) { sets.push('status=?');      vals.push(status) }
    if (assignedTo !== undefined) { sets.push('assigned_to=?'); vals.push(JSON.stringify(assignedTo)) }
    if (refs       !== undefined) { sets.push('refs=?');        vals.push(JSON.stringify(Array.isArray(refs) ? refs : [])) }
    // "Entrega" = cierre del ticket: guarda closed_at al cerrar (y lo limpia al reabrir).
    if (status === 'closed') { sets.push('closed_at=?'); vals.push(Date.now()) }
    else if (status !== undefined) { sets.push('closed_at=?'); vals.push(null) }
    vals.push(ticketId)
    await pool.query(`UPDATE support_tickets SET ${sets.join(',')} WHERE id=?`, vals)
    socket.broadcast('support:updated', { accId: tkt.account_id })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateStatus = async (req, res) => {
  const { ticketId } = req.params
  const { status } = req.body
  // Cambiar el estado (cerrar / reactivar) es exclusivo del super admin.
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo un super admin puede cambiar el estado del ticket.' })
  try {
    const [[tkt]] = await pool.query('SELECT account_id FROM support_tickets WHERE id=?', [ticketId])
    const closedSet = status === 'closed' ? ', closed_at=' + Date.now() : (status ? ', closed_at=NULL' : '')
    await pool.query(`UPDATE support_tickets SET status=?,updated_at=?${closedSet} WHERE id=?`, [status, Date.now(), ticketId])
    socket.broadcast('support:updated', { accId: tkt?.account_id })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Registra una entrada en el historial de tomas/asignaciones del ticket.
function histEntry(raw, { saId, saName, action, by }) {
  const hist = parseJ(raw, [])
  hist.push({ saId: saId || null, saName: saName || '', action, byId: by?.id || null, byName: by?.name || '', at: Date.now() })
  return JSON.stringify(hist)
}

// Asignar sincroniza la TOMA: el ticket pasa al nuevo asesor CON toma incluida (y a "en
// proceso"). Si se desasigna (saId vacío), queda sin asignar/sin tomar y vuelve a "abierto".
// Todo cambio queda en el historial de asignaciones.
const assignTicket = async (req, res) => {
  const { ticketId } = req.params
  const { saId, saName } = req.body
  try {
    const [[tkt]] = await pool.query('SELECT account_id, assign_history FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    const clearing = !saId
    const who = clearing ? null : JSON.stringify({ saId, saName })
    const hist = histEntry(tkt.assign_history, { saId, saName, action: clearing ? 'unassigned' : 'assigned', by: req.user })
    if (clearing) {
      await pool.query('UPDATE support_tickets SET assigned_to=NULL,taken_by=NULL,taken_at=NULL,status=IF(status="closed",status,"open"),assign_history=?,updated_at=? WHERE id=?', [hist, Date.now(), ticketId])
    } else {
      await pool.query('UPDATE support_tickets SET assigned_to=?,taken_by=?,taken_at=?,status=IF(status="closed",status,"in_progress"),assign_history=?,updated_at=? WHERE id=?', [who, who, Date.now(), hist, Date.now(), ticketId])
    }
    socket.broadcast('support:updated', { accId: tkt?.account_id })
    res.json({ ok: true })
  } catch (err) { console.error('[support assign]', err); res.status(500).json({ error: 'Error interno' }) }
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

// Un super admin TOMA el ticket (lo reclama). Cualquier super admin puede tomar un ticket
// que aún no ha sido tomado (aunque esté pre-asignado a otro por round-robin), para que los
// tickets que llevan mucho esperando puedan atenderse por otro.
const takeTicket = async (req, res) => {
  const { ticketId } = req.params
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo un super admin puede tomar tickets.' })
  const saId = req.user.id, saName = req.user.name
  try {
    const [[tkt]] = await pool.query('SELECT account_id, taken_by, assign_history FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    const taken = parseJ(tkt.taken_by, null)
    if (taken && taken.saId && taken.saId !== saId) {
      return res.status(409).json({ error: `Ya lo tomó ${taken.saName || 'otro asesor'}.`, takenBy: taken })
    }
    const me = JSON.stringify({ saId, saName })
    const hist = histEntry(tkt.assign_history, { saId, saName, action: 'taken', by: req.user })
    // Tomar un ticket lo pasa automáticamente a "en proceso" (si no está cerrado).
    await pool.query('UPDATE support_tickets SET assigned_to=?,taken_by=?,taken_at=?,status=IF(status="closed",status,"in_progress"),assign_history=?,updated_at=? WHERE id=?', [me, me, Date.now(), hist, Date.now(), ticketId])
    socket.broadcast('support:updated', { accId: tkt.account_id })
    res.json({ ok: true })
  } catch (err) { console.error('[support take]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Prioridad manual (daño al cliente) que fija el super admin que lee el ticket.
const PRIORITIES = ['baja', 'media', 'alta', 'urgente']
const setPriority = async (req, res) => {
  const { ticketId } = req.params
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo un super admin puede fijar la prioridad.' })
  const priority = req.body?.priority === null ? null : String(req.body?.priority || '')
  if (priority !== null && !PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Prioridad inválida.' })
  try {
    const [[tkt]] = await pool.query('SELECT account_id FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    await pool.query('UPDATE support_tickets SET priority=?,updated_at=? WHERE id=?', [priority, Date.now(), ticketId])
    socket.broadcast('support:updated', { accId: tkt.account_id })
    res.json({ ok: true })
  } catch (err) { console.error('[support priority]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Notas internas del super admin sobre el ticket (no visibles para el cliente).
const addNote = async (req, res) => {
  const { ticketId } = req.params
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo un super admin puede agregar notas.' })
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'La nota está vacía.' })
  try {
    const [[tkt]] = await pool.query('SELECT account_id, notes FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    const notes = parseJ(tkt.notes, [])
    const note = { id: 'note_' + uid(), saId: req.user.id, saName: req.user.name, text: text.slice(0, 2000), ts: Date.now() }
    notes.push(note)
    // No toca updated_at: la nota es interna y no debe parecer actividad para el cliente.
    await pool.query('UPDATE support_tickets SET notes=? WHERE id=?', [JSON.stringify(notes), ticketId])
    socket.broadcast('support:updated', { accId: tkt.account_id })
    res.json({ note })
  } catch (err) { console.error('[support addNote]', err); res.status(500).json({ error: 'Error interno' }) }
}
const deleteNote = async (req, res) => {
  const { ticketId, noteId } = req.params
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo un super admin puede borrar notas.' })
  try {
    const [[tkt]] = await pool.query('SELECT account_id, notes FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    const notes = parseJ(tkt.notes, []).filter(n => n.id !== noteId)
    await pool.query('UPDATE support_tickets SET notes=? WHERE id=?', [JSON.stringify(notes), ticketId])
    socket.broadcast('support:updated', { accId: tkt.account_id })
    res.json({ ok: true })
  } catch (err) { console.error('[support delNote]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Fecha aproximada de entrega (ETA). La fija/edita el super admin; se anuncia en el chat
// (mensaje de sistema visible para ambos: cliente y soporte).
function fmtEta(ms) {
  try { return new Date(ms).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  catch { return new Date(ms).toISOString() }
}
const setEta = async (req, res) => {
  const { ticketId } = req.params
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo un super admin puede fijar la fecha de entrega.' })
  const eta = req.body?.eta == null ? null : Number(req.body.eta)
  if (eta !== null && (!Number.isFinite(eta) || eta <= 0)) return res.status(400).json({ error: 'Fecha inválida.' })
  try {
    const [[tkt]] = await pool.query('SELECT account_id, eta FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    const had = tkt.eta != null
    const ts = Date.now()
    await pool.query('UPDATE support_tickets SET eta=?, updated_at=? WHERE id=?', [eta, ts, ticketId])
    const content = eta === null
      ? '📅 Se quitó la fecha aproximada de entrega.'
      : `📅 ${had ? 'La fecha aproximada de entrega se actualizó a' : 'Se estableció una fecha aproximada de entrega'}: ${fmtEta(eta)}.`
    await pool.query('INSERT INTO support_messages (id,ticket_id,role,author_id,author_name,content,ts,media) VALUES (?,?,?,?,?,?,?,?)',
      ['msg_' + uid(), ticketId, 'system', req.user.id, req.user.name, content, ts, null])
    socket.broadcast('support:updated', { accId: tkt.account_id, lastRole: 'system', preview: content })
    res.json({ ok: true })
  } catch (err) { console.error('[support eta]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Reporte del ticket. El cliente (dueño de la cuenta) lo reporta con una nota; el super
// admin puede resolver/limpiar el reporte. Deja constancia en el chat (mensaje de sistema).
const reportTicket = async (req, res) => {
  const { ticketId } = req.params
  const reported = req.body?.reported !== false
  const note = String(req.body?.note || '').trim().slice(0, 1000)
  try {
    const [[tkt]] = await pool.query('SELECT account_id FROM support_tickets WHERE id=?', [ticketId])
    if (!tkt) return res.status(404).json({ error: 'Ticket no encontrado' })
    const isSA = req.user?.type === 'superadmin'
    const ts = Date.now()
    if (reported) {
      // Reportar: cliente de la cuenta (o super admin). Vuelve a "pendiente" si ya estaba resuelto.
      if (!isSA && req.user?.accountId && req.user.accountId !== tkt.account_id) return res.status(403).json({ error: 'No puedes reportar este ticket.' })
      if (!note) return res.status(400).json({ error: 'Escribe una nota del reporte.' })
      const by = JSON.stringify({ id: req.user?.id || null, name: req.user?.name || '' })
      await pool.query('UPDATE support_tickets SET reported=1, report_note=?, reported_at=?, reported_by=?, report_resolved=0, report_resolved_at=NULL, report_resolved_by=NULL, updated_at=? WHERE id=?', [note, ts, by, ts, ticketId])
      await pool.query('INSERT INTO support_messages (id,ticket_id,role,author_id,author_name,content,ts,media) VALUES (?,?,?,?,?,?,?,?)',
        ['msg_' + uid(), ticketId, 'system', req.user?.id || null, req.user?.name || '', `⚠ El cliente reportó este ticket: ${note}`, ts, null])
    } else {
      // Resolver el reporte: solo super admin. NO borra la marca `reported` — el ticket
      // queda registrado como reportado (no sale de la lista), solo pasa a "atendido".
      if (!isSA) return res.status(403).json({ error: 'Solo un super admin puede resolver el reporte.' })
      const by = JSON.stringify({ id: req.user.id, name: req.user.name })
      await pool.query('UPDATE support_tickets SET report_resolved=1, report_resolved_at=?, report_resolved_by=?, updated_at=? WHERE id=?', [ts, by, ts, ticketId])
      await pool.query('INSERT INTO support_messages (id,ticket_id,role,author_id,author_name,content,ts,media) VALUES (?,?,?,?,?,?,?,?)',
        ['msg_' + uid(), ticketId, 'system', req.user.id, req.user.name, '✅ El reporte del ticket fue atendido por soporte.', ts, null])
    }
    socket.broadcast('support:updated', { accId: tkt.account_id, lastRole: 'system' })
    res.json({ ok: true })
  } catch (err) { console.error('[support report]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { getAllTickets, createTicket, addMessage, updateTicket, updateStatus, assignTicket, submitRating, takeTicket, setPriority, addNote, deleteNote, setEta, reportTicket }
