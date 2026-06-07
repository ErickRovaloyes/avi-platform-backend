'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// ── Members ───────────────────────────────────────────────────────────────────

const createMember = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, email, password, roleId, agentAccess = [], avatar } = req.body
  const id = gId || ('mem_' + uid())
  try {
    await pool.query(
      'INSERT INTO members (id,account_id,name,email,password,avatar,role_id,agent_access,status) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, accId, name, email, password || '', avatar || (name || '').slice(0, 2).toUpperCase(), roleId, JSON.stringify(agentAccess), 'active']
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) {
    console.error('[POST MEMBER]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const updateMember = async (req, res) => {
  const { accId, memId } = req.params
  const { name, email, roleId, agentAccess, status, password, avatar } = req.body
  try {
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');         vals.push(name) }
    if (email       !== undefined) { sets.push('email=?');        vals.push(email) }
    if (roleId      !== undefined) { sets.push('role_id=?');      vals.push(roleId) }
    if (agentAccess !== undefined) { sets.push('agent_access=?'); vals.push(JSON.stringify(agentAccess)) }
    if (status      !== undefined) { sets.push('status=?');       vals.push(status) }
    if (avatar      !== undefined) { sets.push('avatar=?');       vals.push(avatar) }
    // Only update the password when a non-empty value is provided
    if (password)                  { sets.push('password=?');     vals.push(password) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(memId, accId)
    await pool.query(`UPDATE members SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email ya en uso' })
    res.status(500).json({ error: 'Error interno' })
  }
}

const deleteMember = async (req, res) => {
  const { accId, memId } = req.params
  try {
    await pool.query('DELETE FROM members WHERE id=? AND account_id=?', [memId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Roles ─────────────────────────────────────────────────────────────────────

const createRole = async (req, res) => {
  const { accId } = req.params
  const { name, permissions = {} } = req.body
  const id = 'role_' + uid()
  try {
    await pool.query('INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,0,?)', [id, accId, name, JSON.stringify(permissions)])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateRole = async (req, res) => {
  const { accId, roleId } = req.params
  const { name, permissions } = req.body
  try {
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');        vals.push(name) }
    if (permissions !== undefined) { sets.push('permissions=?'); vals.push(JSON.stringify(permissions)) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(roleId, accId)
    await pool.query(`UPDATE roles SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteRole = async (req, res) => {
  const { accId, roleId } = req.params
  try {
    await pool.query('DELETE FROM roles WHERE id=? AND account_id=? AND is_system=0', [roleId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Labels ────────────────────────────────────────────────────────────────────

const createLabel = async (req, res) => {
  const { accId } = req.params
  const { name, color } = req.body
  const id = 'lbl_' + uid()
  try {
    await pool.query('INSERT INTO labels (id,account_id,name,color) VALUES (?,?,?,?)', [id, accId, name, color])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateLabel = async (req, res) => {
  const { accId, lblId } = req.params
  const { name, color } = req.body
  try {
    await pool.query('UPDATE labels SET name=?,color=? WHERE id=? AND account_id=?', [name, color, lblId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteLabel = async (req, res) => {
  const { accId, lblId } = req.params
  try {
    await pool.query('DELETE FROM labels WHERE id=? AND account_id=?', [lblId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = {
  createMember, updateMember, deleteMember,
  createRole, updateRole, deleteRole,
  createLabel, updateLabel, deleteLabel,
}
