'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const { resolveSegment } = require('../services/segments')

const map = s => ({ id: s.id, name: s.name, rules: parseJ(s.rules, {}), createdAt: s.created_at })

const list = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM contact_segments WHERE account_id=? ORDER BY created_at DESC', [accId])
    res.json(rows.map(map))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const name = String(req.body?.name || '').trim() || 'Segmento'
  const rules = (req.body?.rules && typeof req.body.rules === 'object') ? req.body.rules : {}
  const id = 'seg_' + uid()
  try {
    await pool.query('INSERT INTO contact_segments (id,account_id,name,rules,created_at) VALUES (?,?,?,?,?)', [id, accId, name, JSON.stringify(rules), Date.now()])
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const update = async (req, res) => {
  const { accId, id } = req.params
  try {
    const sets = [], vals = []
    if (req.body?.name !== undefined) { sets.push('name=?'); vals.push(String(req.body.name || '').trim() || 'Segmento') }
    if (req.body?.rules !== undefined) { sets.push('rules=?'); vals.push(JSON.stringify(req.body.rules || {})) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id, accId)
    await pool.query(`UPDATE contact_segments SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  try { await pool.query('DELETE FROM contact_segments WHERE id=? AND account_id=?', [id, accId]); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Vista previa de reglas (sin guardar): cuántos contactos y una muestra.
const preview = async (req, res) => {
  const { accId } = req.params
  try {
    const contacts = await resolveSegment(accId, req.body?.rules || {})
    res.json({ count: contacts.length, withPhone: contacts.filter(c => c.phone).length, sample: contacts.slice(0, 8).map(c => ({ id: c.id, name: c.name, orders: c.orders, spend: Math.round(c.spend) })) })
  } catch (err) { console.error('[segment preview]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, update, remove, preview }
