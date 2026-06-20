'use strict'
/**
 * Filtros guardados del inbox. Dos ámbitos:
 *   - personal: lo ve/borra sólo quien lo creó (cualquier miembro puede crearlos).
 *   - global:   lo ven todos los miembros; sólo el OWNER de la cuenta puede crear/borrar.
 */
const pool = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// El owner es el miembro cuyo rol se llama "Owner".
async function isAccountOwner(accId, userId) {
  if (!userId) return false
  try {
    const [[m]] = await pool.query('SELECT role_id FROM members WHERE id=? AND account_id=?', [userId, accId])
    if (!m) return false
    const [[r]] = await pool.query('SELECT name FROM roles WHERE id=? AND account_id=?', [m.role_id, accId])
    return !!(r && String(r.name).trim().toLowerCase() === 'owner')
  } catch { return false }
}

const list = async (req, res) => {
  const { accId } = req.params
  const userId = req.user?.id
  try {
    const [rows] = await pool.query(
      "SELECT * FROM saved_filters WHERE account_id=? AND (scope='global' OR owner_id=?) ORDER BY scope DESC, created_at ASC",
      [accId, userId || '']
    )
    const canCreateGlobal = await isAccountOwner(accId, userId)
    res.json({
      canCreateGlobal,
      filters: rows.map(r => ({
        id: r.id, name: r.name, scope: r.scope, ownerId: r.owner_id,
        payload: parseJ(r.payload, {}), mine: r.owner_id === userId,
      })),
    })
  } catch (err) { console.error('[savedFilters list]', err); res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const userId = req.user?.id
  const { name, scope = 'personal', payload = {} } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nombre requerido' })
  const finalScope = scope === 'global' ? 'global' : 'personal'
  if (finalScope === 'global' && !(await isAccountOwner(accId, userId))) {
    return res.status(403).json({ error: 'Sólo el owner de la cuenta puede crear filtros globales' })
  }
  const id = 'flt_' + uid()
  try {
    await pool.query(
      'INSERT INTO saved_filters (id,account_id,owner_id,scope,name,payload,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, accId, userId || '', finalScope, String(name).trim().slice(0, 120), JSON.stringify(payload || {}), Date.now()]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id, scope: finalScope })
  } catch (err) { console.error('[savedFilters create]', err); res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  const userId = req.user?.id
  try {
    const [[f]] = await pool.query('SELECT scope, owner_id FROM saved_filters WHERE id=? AND account_id=?', [id, accId])
    if (!f) return res.json({ ok: true })
    if (f.scope === 'global') {
      if (!(await isAccountOwner(accId, userId))) return res.status(403).json({ error: 'Sólo el owner puede borrar filtros globales' })
    } else if (f.owner_id !== userId) {
      return res.status(403).json({ error: 'No puedes borrar el filtro de otro miembro' })
    }
    await pool.query('DELETE FROM saved_filters WHERE id=? AND account_id=?', [id, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, remove }
