'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// ── Members ───────────────────────────────────────────────────────────────────

const createMember = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, email, password, roleId, agentAccess = [], avatar } = req.body
  const cleanEmail = String(email || '').trim()
  try {
    // Idempotencia: una identidad (email) solo puede tener UNA membresía por cuenta.
    // Si ya existe, se actualiza (fusiona accesos a agentes) en vez de crear un duplicado.
    if (cleanEmail) {
      const [[existing]] = await pool.query('SELECT * FROM members WHERE account_id=? AND email=? LIMIT 1', [accId, cleanEmail])
      if (existing) {
        const mergedAccess = [...new Set([...(parseJ(existing.agent_access, [])), ...(Array.isArray(agentAccess) ? agentAccess : [])])]
        const sets = ['agent_access=?', 'status=?']; const vals = [JSON.stringify(mergedAccess), 'active']
        if (name)     { sets.push('name=?');    vals.push(name) }
        if (roleId)   { sets.push('role_id=?'); vals.push(roleId) }
        if (password) { sets.push('password=?'); vals.push(password) }
        vals.push(existing.id, accId)
        await pool.query(`UPDATE members SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
        socket.emit(accId, 'account:updated', { accId })
        return res.json({ id: existing.id, existed: true })
      }
    }
    const id = gId || ('mem_' + uid())
    await pool.query(
      'INSERT INTO members (id,account_id,name,email,password,avatar,role_id,agent_access,status) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, accId, name, cleanEmail, password || '', avatar || (name || '').slice(0, 2).toUpperCase(), roleId, JSON.stringify(agentAccess), 'active']
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
  // Solo un super admin (directo o impersonando) puede eliminar usuarios.
  const isSA = req.user?.type === 'superadmin' || req.user?.isImpersonating
  if (!isSA) return res.status(403).json({ error: 'Solo un super admin puede eliminar usuarios.' })
  try {
    await pool.query('DELETE FROM members WHERE id=? AND account_id=?', [memId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Elimina un usuario por completo (todas sus membresías) — solo super admin.
// Útil para limpiar identidades duplicadas o dar de baja a alguien de toda la plataforma.
const deleteUserEverywhere = async (req, res) => {
  const isSA = req.user?.type === 'superadmin' || req.user?.isImpersonating
  if (!isSA) return res.status(403).json({ error: 'Solo un super admin puede eliminar usuarios.' })
  const email = String(req.body?.email || req.params?.email || '').trim()
  if (!email) return res.status(400).json({ error: 'Email requerido' })
  try {
    const [rows] = await pool.query('SELECT DISTINCT account_id FROM members WHERE email=?', [email])
    const [r] = await pool.query('DELETE FROM members WHERE email=?', [email])
    for (const { account_id } of rows) socket.emit(account_id, 'account:updated', { accId: account_id })
    res.json({ ok: true, removed: r.affectedRows || 0 })
  } catch (err) { console.error('[DELETE USER]', err); res.status(500).json({ error: 'Error interno' }) }
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
  createMember, updateMember, deleteMember, deleteUserEverywhere,
  createRole, updateRole, deleteRole,
  createLabel, updateLabel, deleteLabel,
}
