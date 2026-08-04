'use strict'
/**
 * Mensajes PROGRAMADOS: el asesor escribe ahora y se entrega a la hora indicada.
 *
 * Regla de negocio: en WhatsApp, Messenger e Instagram la entrega no puede salirse de la
 * ventana de servicio de 24 h (Meta rechaza el texto libre fuera de ella), así que se valida
 * al programar Y otra vez justo antes de enviar — la ventana puede haberse cerrado entre
 * medias, o haberse renovado si el cliente escribió. En webchat y prueba no hay límite.
 *
 * La entrega reutiliza `deliverManualMessage` del controlador de conversaciones: mismo
 * camino que el envío normal del asesor (canal externo + persistencia + socket).
 */
const pool = require('../db')
const { uid } = require('../utils')
const socket = require('./socket')

const MAX_FUTURE_MS = 365 * 24 * 3600 * 1000   // tope de cordura para canales sin ventana

// Import perezoso: el controlador requiere servicios que a su vez podrían requerir este.
const convCtrl = () => require('../controllers/conversations.controller')

const map = r => ({
  id: r.id, accountId: r.account_id, agentId: r.agent_id, conversationId: r.conversation_id,
  channelType: r.channel_type, content: r.content, scheduledAt: Number(r.scheduled_at) || 0,
  status: r.status || 'pending', error: r.error || null,
  createdBy: r.created_by || null, createdByName: r.created_by_name || '',
  createdAt: Number(r.created_at) || 0, sentAt: r.sent_at ? Number(r.sent_at) : null,
})

/**
 * Valida que se pueda programar para `scheduledAt`.
 * → { ok } | { ok:false, error, code, expiresAt }
 */
async function validateSchedule(convId, channelType, scheduledAt) {
  const now = Date.now()
  if (!scheduledAt || scheduledAt <= now) return { ok: false, error: 'La fecha debe ser futura' }
  const win = await convCtrl().serviceWindow(convId, channelType)
  if (!win.applies) {
    if (scheduledAt - now > MAX_FUTURE_MS) return { ok: false, error: 'La fecha es demasiado lejana (máximo 1 año)' }
    return { ok: true }
  }
  if (!win.open) {
    return { ok: false, code: 'window_closed', error: 'La ventana de 24 h de este canal está cerrada: no se puede programar un mensaje de texto.' }
  }
  if (scheduledAt > win.expiresAt) {
    return {
      ok: false, code: 'window_exceeded', expiresAt: win.expiresAt,
      error: `La ventana de 24 h de este canal se cierra el ${new Date(win.expiresAt).toLocaleString('es')}. Programa el mensaje antes de esa hora.`,
    }
  }
  return { ok: true }
}

async function create(accId, { agentId, convId, content, scheduledAt, createdBy, createdByName } = {}) {
  if (!content || !String(content).trim()) throw new Error('El mensaje está vacío')
  const [[conv]] = await pool.query('SELECT channel_type FROM conversations WHERE id=? AND account_id=?', [convId, accId])
  if (!conv) throw new Error('Conversación no encontrada')
  const when = Number(scheduledAt) || 0
  const v = await validateSchedule(convId, conv.channel_type, when)
  if (!v.ok) { const e = new Error(v.error); e.code = v.code; e.expiresAt = v.expiresAt; throw e }

  const id = 'schm_' + uid()
  await pool.query(
    `INSERT INTO scheduled_messages
       (id, account_id, agent_id, conversation_id, channel_type, content, scheduled_at, status, created_by, created_by_name, created_at)
     VALUES (?,?,?,?,?,?,?, 'pending', ?,?,?)`,
    [id, accId, agentId || null, convId, conv.channel_type, String(content), when, createdBy || null, createdByName || '', Date.now()]
  )
  socket.emit(accId, 'scheduled:updated', { accId, convId })
  const [[row]] = await pool.query('SELECT * FROM scheduled_messages WHERE id=?', [id])
  return map(row)
}

// Lista por cuenta; opcionalmente de una conversación y/o por estado.
async function list(accId, { convId, status, limit = 100 } = {}) {
  const where = ['account_id=?']; const params = [accId]
  if (convId) { where.push('conversation_id=?'); params.push(convId) }
  if (status) { where.push('status=?'); params.push(status) }
  const [rows] = await pool.query(
    `SELECT * FROM scheduled_messages WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, scheduled_at ASC LIMIT ?`,
    [...params, Math.min(500, Number(limit) || 100)]
  )
  return rows.map(map)
}

async function cancel(accId, id) {
  await pool.query("UPDATE scheduled_messages SET status='cancelled' WHERE id=? AND account_id=? AND status='pending'", [id, accId])
  socket.emit(accId, 'scheduled:updated', { accId })
  return { ok: true }
}

// ── Worker: entrega los mensajes vencidos ────────────────────────────────────
async function processDue() {
  const now = Date.now()
  let rows = []
  try {
    [rows] = await pool.query(
      "SELECT * FROM scheduled_messages WHERE status='pending' AND scheduled_at<=? ORDER BY scheduled_at ASC LIMIT 50", [now]
    )
  } catch { return }   // tabla aún no migrada
  for (const r of rows) {
    try {
      // La ventana pudo cerrarse desde que se programó → se vuelve a comprobar.
      const win = await convCtrl().serviceWindow(r.conversation_id, r.channel_type)
      if (win.applies && !win.open) {
        await pool.query("UPDATE scheduled_messages SET status='failed', error=? WHERE id=?",
          ['La ventana de 24 h se cerró antes de la entrega', r.id])
        socket.emit(r.account_id, 'scheduled:updated', { accId: r.account_id, convId: r.conversation_id })
        continue
      }
      const out = await convCtrl().deliverManualMessage(r.account_id, r.agent_id, r.conversation_id, {
        text: r.content, senderName: r.created_by_name || 'Asesor',
      })
      if (out?.ok) {
        await pool.query("UPDATE scheduled_messages SET status='sent', sent_at=? WHERE id=?", [Date.now(), r.id])
      } else {
        await pool.query("UPDATE scheduled_messages SET status='failed', error=? WHERE id=?",
          [String(out?.error || 'No se pudo entregar').slice(0, 250), r.id])
      }
      socket.emit(r.account_id, 'scheduled:updated', { accId: r.account_id, convId: r.conversation_id })
    } catch (e) {
      try {
        await pool.query("UPDATE scheduled_messages SET status='failed', error=? WHERE id=?", [String(e.message).slice(0, 250), r.id])
      } catch {}
      console.warn('[scheduledMessages]', r.id, e.message)
    }
  }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(() => processDue().catch(() => {}), 60 * 1000)  // cada minuto
  _timer.unref?.()
  setTimeout(() => processDue().catch(() => {}), 20000)                // primer pase a los 20 s
}

module.exports = { create, list, cancel, validateSchedule, processDue, startWorker }
