'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')

const getByToken = async (req, res) => {
  try {
    const [[inv]] = await pool.query('SELECT * FROM invites WHERE token=? AND used_at IS NULL', [req.params.token])
    if (!inv) return res.status(404).json({ error: 'Invitación inválida o ya usada' })
    res.json({ id: inv.id, token: inv.token, accountId: inv.account_id, agentId: inv.agent_id, roleId: inv.role_id, createdBy: inv.created_by, createdAt: inv.created_at })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const listInvites = async (req, res) => {
  const { accountId } = req.query
  try {
    const [rows] = await pool.query('SELECT * FROM invites WHERE account_id=? ORDER BY created_at DESC', [accountId])
    res.json(rows.map(i => ({ id: i.id, token: i.token, accountId: i.account_id, agentId: i.agent_id, roleId: i.role_id, createdBy: i.created_by, createdAt: i.created_at, usedAt: i.used_at, usedBy: i.used_by })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createInvite = async (req, res) => {
  const { accountId, agentId, roleId, createdBy } = req.body
  const token = uid() + uid() + uid()
  const id    = 'inv_' + uid()
  try {
    await pool.query(
      'INSERT INTO invites (id,token,account_id,agent_id,role_id,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, token, accountId, agentId || null, roleId, createdBy || '', Date.now()]
    )
    res.json({ token })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const acceptInvite = async (req, res) => {
  const { token } = req.params
  const isAuth   = !!req.user
  // When the caller is authenticated, trust the JWT email over the body — prevents
  // spoofing and avoids edge cases where the InvitePage sends an outdated/wrong email.
  const email    = (isAuth && req.user?.email ? req.user.email : req.body.email || '').trim().toLowerCase()
  const name     = (req.body.name || req.user?.name || '').trim() || email
  const password = req.body.password

  if (!email) return res.status(400).json({ error: 'Email requerido' })

  try {
    const [[inv]] = await pool.query('SELECT * FROM invites WHERE token=? AND used_at IS NULL', [token])
    if (!inv) return res.status(400).json({ error: 'Invitación inválida o ya usada' })

    // Super-admin (not impersonating) doesn't need a member row — they already have global
    // access. Just mark the invite as consumed so it can't be reused.
    if (isAuth && req.user?.type === 'superadmin' && !req.user.accountId) {
      await pool.query('UPDATE invites SET used_at=?,used_by=? WHERE token=?', [Date.now(), email, token])
      return res.json({ accountId: inv.account_id, agentId: inv.agent_id, superadminPassthrough: true })
    }

    const [[existing]] = await pool.query('SELECT * FROM members WHERE account_id=? AND email=?', [inv.account_id, email])
    if (existing) {
      // Already a member of this account — grant access to the agent in the invite (if any)
      if (inv.agent_id) {
        const acc = parseJ(existing.agent_access, [])
        if (!acc.includes(inv.agent_id)) {
          await pool.query('UPDATE members SET agent_access=? WHERE id=?', [JSON.stringify([...acc, inv.agent_id]), existing.id])
        }
      }
    } else {
      // Brand new membership in this account. Reuse the user's password from any OTHER
      // account they belong to (must be non-empty). NULL/empty passwords are filtered out
      // because they would block future logins.
      const [[siblingMember]] = await pool.query(
        `SELECT name, password FROM members
         WHERE email=? AND status='active' AND password IS NOT NULL AND password<>''
         LIMIT 1`,
        [email]
      )
      const finalPassword = (password && password.trim()) || siblingMember?.password || ''
      const finalName     = (name && name.trim())         || siblingMember?.name     || email
      if (!finalPassword) {
        return res.status(400).json({
          error: isAuth
            ? 'No se pudo copiar tu contraseña desde otra cuenta. Cierra sesión y acepta la invitación creando una nueva cuenta, o pide al admin que te invite directamente.'
            : 'Se requiere una contraseña para registrar la cuenta',
          needsPassword: true,
        })
      }

      const memId = 'mem_' + uid()
      await pool.query(
        'INSERT INTO members (id,account_id,name,email,password,avatar,role_id,agent_access,status) VALUES (?,?,?,?,?,?,?,?,?)',
        [memId, inv.account_id, finalName, email, finalPassword,
         (finalName || '').slice(0, 2).toUpperCase(), inv.role_id,
         JSON.stringify(inv.agent_id ? [inv.agent_id] : []), 'active']
      )
    }
    await pool.query('UPDATE invites SET used_at=?,used_by=? WHERE token=?', [Date.now(), email, token])
    res.json({ accountId: inv.account_id, agentId: inv.agent_id })
  } catch (err) {
    console.error('[ACCEPT INVITE]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

const deleteInvite = async (req, res) => {
  try {
    await pool.query('DELETE FROM invites WHERE token=?', [req.params.token])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { getByToken, listInvites, createInvite, acceptInvite, deleteInvite }
