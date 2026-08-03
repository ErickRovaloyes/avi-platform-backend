'use strict'
/**
 * Notificaciones de la campanita, persistidas por cuenta + miembro.
 *
 * Antes vivían solo en el localStorage del navegador, así que se perdían al limpiar la
 * caché, no se sincronizaban entre dispositivos y desaparecían al recargar. Ahora se
 * guardan en BD; el navegador sigue DETECTANDO los eventos (sockets) y las registra aquí.
 *
 * Aislamiento: siempre se filtra por la cuenta de la sesión y por el miembro autenticado,
 * nunca por parámetros del cliente.
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')

const KEEP_DAYS = 90     // antigüedad máxima
const KEEP_MAX  = 500    // máximo por miembro

// Miembro dueño de la petición. El super admin impersonando usa su id de sesión.
const meOf = req => String(req.user?.id || '')
// Solo se opera sobre la cuenta de la sesión (un super admin sin cuenta activa no aplica).
function guard(req, res) {
  const accId = req.params.accId
  if (!accId || (req.user?.accountId && req.user.accountId !== accId)) {
    res.status(403).json({ error: 'No autorizado' }); return null
  }
  const memberId = meOf(req)
  if (!memberId) { res.status(400).json({ error: 'Sesión sin miembro' }); return null }
  return { accId, memberId }
}

const map = n => ({
  id: n.id, type: n.type || 'system', prefKey: n.pref_key || null,
  icon: n.icon || '🔔', title: n.title || '', body: n.body || '',
  link: n.link || null, meta: parseJ(n.meta, null),
  read: !!n.is_read, ts: Number(n.created_at) || 0,
})

const list = async (req, res) => {
  const g = guard(req, res); if (!g) return
  try {
    const limit = Math.min(200, Number(req.query.limit) || 100)
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE account_id=? AND member_id=? ORDER BY created_at DESC LIMIT ?',
      [g.accId, g.memberId, limit]
    )
    res.json({ notifications: rows.map(map) })
  } catch (err) { console.error('[notifications list]', err); res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const g = guard(req, res); if (!g) return
  const b = req.body || {}
  try {
    const id = 'n_' + uid()
    const now = Date.now()
    // dedupe_key: si dos pestañas del mismo usuario reciben el mismo evento, solo entra una.
    // NULL no colisiona en un UNIQUE de MySQL, así que sin clave se permiten repetidos.
    const dedupe = b.dedupeKey ? String(b.dedupeKey).slice(0, 120) : null
    const [r] = await pool.query(
      `INSERT IGNORE INTO notifications
         (id, account_id, member_id, type, pref_key, icon, title, body, link, meta, is_read, dedupe_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      [id, g.accId, g.memberId, String(b.type || 'system').slice(0, 30),
       b.prefKey ? String(b.prefKey).slice(0, 40) : null, String(b.icon || '🔔').slice(0, 16),
       String(b.title || '').slice(0, 200), String(b.body || ''),
       b.link ? String(b.link).slice(0, 60) : null,
       b.meta ? JSON.stringify(b.meta) : null, dedupe, now]
    )
    if (!r?.affectedRows) return res.json({ duplicate: true })   // ya existía por dedupe_key
    // Purga barata: solo al insertar, conserva 90 días / 500 por miembro.
    pool.query('DELETE FROM notifications WHERE account_id=? AND member_id=? AND created_at < ?',
      [g.accId, g.memberId, now - KEEP_DAYS * 86400000]).catch(() => {})
    pool.query(
      `DELETE FROM notifications WHERE account_id=? AND member_id=? AND id NOT IN (
         SELECT id FROM (SELECT id FROM notifications WHERE account_id=? AND member_id=?
                         ORDER BY created_at DESC LIMIT ?) keep)`,
      [g.accId, g.memberId, g.accId, g.memberId, KEEP_MAX]).catch(() => {})
    res.json({ notification: map({ id, account_id: g.accId, member_id: g.memberId, type: b.type, pref_key: b.prefKey, icon: b.icon, title: b.title, body: b.body, link: b.link, meta: b.meta ? JSON.stringify(b.meta) : null, is_read: 0, created_at: now }) })
  } catch (err) { console.error('[notifications create]', err); res.status(500).json({ error: 'Error interno' }) }
}

const markRead = async (req, res) => {
  const g = guard(req, res); if (!g) return
  try {
    await pool.query('UPDATE notifications SET is_read=1 WHERE id=? AND account_id=? AND member_id=?',
      [req.params.id, g.accId, g.memberId])
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

const markAllRead = async (req, res) => {
  const g = guard(req, res); if (!g) return
  try {
    await pool.query('UPDATE notifications SET is_read=1 WHERE account_id=? AND member_id=? AND is_read=0', [g.accId, g.memberId])
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const g = guard(req, res); if (!g) return
  try {
    await pool.query('DELETE FROM notifications WHERE id=? AND account_id=? AND member_id=?', [req.params.id, g.accId, g.memberId])
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

const clear = async (req, res) => {
  const g = guard(req, res); if (!g) return
  try {
    await pool.query('DELETE FROM notifications WHERE account_id=? AND member_id=?', [g.accId, g.memberId])
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, markRead, markAllRead, remove, clear }
