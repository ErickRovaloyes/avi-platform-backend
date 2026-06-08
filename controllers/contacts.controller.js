'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')

const mapContact = c => ({
  id: c.id, name: c.name, email: c.email, phone: c.phone,
  createdAt: c.created_at,
  ...parseJ(c.extra, {}),
})

const list = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM contacts WHERE account_id=? ORDER BY created_at DESC', [accId])
    res.json(rows.map(mapContact))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const getOne = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[row]] = await pool.query('SELECT * FROM contacts WHERE id=? AND account_id=?', [id, accId])
    if (!row) return res.status(404).json({ error: 'Contacto no encontrado' })
    res.json(mapContact(row))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const { id, name = '', email = '', phone = '', ...extra } = req.body || {}
  const finalId = id || 'contact_' + uid()
  try {
    await pool.query(
      'INSERT INTO contacts (id, account_id, name, email, phone, extra, created_at) VALUES (?,?,?,?,?,?,?)',
      [finalId, accId, name, email, phone, JSON.stringify(extra || {}), Date.now()]
    )
    res.json({ id: finalId })
  } catch (err) { console.error('[CREATE CONTACT]', err); res.status(500).json({ error: err.message }) }
}

const update = async (req, res) => {
  const { accId, id } = req.params
  const { name, email, phone, ...extra } = req.body || {}
  try {
    const sets = []; const vals = []
    if (name  !== undefined) { sets.push('name=?');  vals.push(name) }
    if (email !== undefined) { sets.push('email=?'); vals.push(email) }
    if (phone !== undefined) { sets.push('phone=?'); vals.push(phone) }
    if (Object.keys(extra).length) {
      const [[row]] = await pool.query('SELECT extra FROM contacts WHERE id=? AND account_id=?', [id, accId])
      const merged = { ...parseJ(row?.extra, {}), ...extra }
      sets.push('extra=?'); vals.push(JSON.stringify(merged))
    }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id, accId)
    await pool.query(`UPDATE contacts SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query('DELETE FROM contacts WHERE id=? AND account_id=?', [id, accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const listConversations = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [rows] = await pool.query(
      `SELECT id, agent_id, channel_type, guest_name, preview, created_at, updated_at
       FROM conversations
       WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars, '$.contact_id'))=?
       ORDER BY updated_at DESC
       LIMIT 50`,
      [accId, id]
    )
    res.json(rows.map(c => ({
      id: c.id, agentId: c.agent_id, channel: c.channel_type,
      guestName: c.guest_name, preview: c.preview,
      createdAt: c.created_at, updatedAt: c.updated_at,
    })))
  } catch (err) {
    console.error('[CONTACT CONVOS]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = { list, getOne, create, update, remove, listConversations }
