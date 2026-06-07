'use strict'
const pool = require('../db')
const { sign } = require('../auth')
const { parseJ } = require('../utils')

const login = async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' })
  try {
    const [sas] = await pool.query('SELECT * FROM super_admins WHERE email=? AND password=?', [email, password])
    if (sas.length) {
      const sa = sas[0]
      const session = { type: 'superadmin', id: sa.id, name: sa.name, email: sa.email }
      return res.json({ token: sign(session), session })
    }
    const [rows] = await pool.query(
      `SELECT m.*, a.name AS accountName, a.id AS accId
       FROM members m JOIN accounts a ON m.account_id = a.id
       WHERE m.email=? AND m.password=? AND m.status='active'`,
      [email, password]
    )
    if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' })
    const allAccountIds = [...new Set(rows.map(r => r.accId))]
    const first         = rows[0]
    const [roleRows]    = await pool.query('SELECT * FROM roles WHERE id=?', [first.role_id])
    const role          = roleRows[0]
    const session = {
      type: 'member', id: first.id, name: first.name, email: first.email,
      accountId: first.accId, accountName: first.accountName,
      allAccountIds,
      roleId: first.role_id, permissions: parseJ(role?.permissions, {}),
      agentAccess: parseJ(first.agent_access, []),
    }
    res.json({ token: sign(session), session })
  } catch (err) {
    console.error('[LOGIN]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const switchAccount = async (req, res) => {
  const { accountId } = req.body
  const allIds = req.user.allAccountIds || [req.user.accountId].filter(Boolean)
  if (!allIds.includes(accountId)) return res.status(403).json({ error: 'Sin acceso a esa cuenta' })
  try {
    const [[acc]] = await pool.query('SELECT * FROM accounts WHERE id=?', [accountId])
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' })
    const [[mem]] = await pool.query('SELECT * FROM members WHERE account_id=? AND email=?', [accountId, req.user.email])
    if (!mem) return res.status(403).json({ error: 'No eres miembro de esa cuenta' })
    const [[role]] = await pool.query('SELECT * FROM roles WHERE id=?', [mem.role_id])
    const session = {
      ...req.user, accountId, accountName: acc.name,
      roleId: mem.role_id, permissions: parseJ(role?.permissions, {}),
      agentAccess: parseJ(mem.agent_access, []),
    }
    res.json({ token: sign(session), session })
  } catch (err) {
    console.error('[SWITCH]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const impersonate = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { accountId } = req.body
  try {
    const [[acc]] = await pool.query('SELECT * FROM accounts WHERE id=?', [accountId])
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' })
    const session = {
      type: 'member', id: 'sa_impersonate', name: 'Super Admin (vista)',
      email: 'superadmin@avi.com', accountId, accountName: acc.name,
      roleId: 'role_owner', allAccountIds: [accountId],
      permissions: { inbox:true, agents:true, channels:true, crm:true, pipeline:true, config:true, admins:true, flows:true, variables:true, tools:true, knowledge:true },
      agentAccess: [], isImpersonating: true,
    }
    res.json({ token: sign(session), session })
  } catch (err) {
    res.status(500).json({ error: 'Error interno' })
  }
}

// Re-generates the JWT for the authenticated user with up-to-date account membership.
// Useful after accepting an invitation: the new account access becomes part of allAccountIds
// without forcing the user to log out and back in.
const refreshSession = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' })
  try {
    if (req.user.type === 'superadmin') {
      // Super admins keep their type as-is; just re-sign the existing session
      return res.json({ token: sign(req.user), session: req.user })
    }
    const email = req.user.email
    const [rows] = await pool.query(
      `SELECT m.*, a.name AS accountName, a.id AS accId
       FROM members m JOIN accounts a ON m.account_id = a.id
       WHERE m.email=? AND m.status='active'`,
      [email]
    )
    if (!rows.length) return res.status(404).json({ error: 'Sin acceso a ninguna cuenta' })

    const allAccountIds = [...new Set(rows.map(r => r.accId))]
    // Prefer keeping the currently-active account if it's still in the list, otherwise pick first
    const keepActive = allAccountIds.includes(req.user.accountId) ? req.user.accountId : rows[0].accId
    const active = rows.find(r => r.accId === keepActive) || rows[0]
    const [[role]] = await pool.query('SELECT * FROM roles WHERE id=?', [active.role_id])
    const session = {
      type: 'member', id: active.id, name: active.name, email: active.email,
      accountId: active.accId, accountName: active.accountName,
      allAccountIds,
      roleId: active.role_id, permissions: parseJ(role?.permissions, {}),
      agentAccess: parseJ(active.agent_access, []),
    }
    res.json({ token: sign(session), session })
  } catch (err) {
    console.error('[REFRESH]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = { login, switchAccount, impersonate, refreshSession }
