'use strict'
const pool = require('../db')
const { sign } = require('../auth')
const { parseJ } = require('../utils')
const { loadEmailConfig, isConfigured } = require('../services/email')
const { issueCode, verifyCode } = require('../services/verifyCodes')

// Valida credenciales y arma la sesión (super admin o miembro). Devuelve la
// sesión o null si las credenciales no son válidas. Reutilizado por login + 2FA.
async function buildSessionFor(email, password) {
  const [sas] = await pool.query('SELECT * FROM super_admins WHERE email=? AND password=?', [email, password])
  if (sas.length) {
    const sa = sas[0]
    return { type: 'superadmin', id: sa.id, name: sa.name, email: sa.email, photo: sa.photo || null }
  }
  // 1) Verifica la credencial: al menos una fila de miembro activa con email+password.
  const [authRows] = await pool.query(
    `SELECT m.*, a.name AS accountName, a.id AS accId
     FROM members m JOIN accounts a ON m.account_id = a.id
     WHERE m.email=? AND m.password=? AND m.status='active'`,
    [email, password]
  )
  if (!authRows.length) return null
  // 2) La identidad de un miembro es su EMAIL (puede pertenecer a varias cuentas, y las
  //    contraseñas entre filas pueden haber quedado desincronizadas por datos legados).
  //    Una vez verificada la credencial, reunimos TODAS las cuentas activas de ese email
  //    para que el selector de "cambiar cuenta" las muestre todas (igual que refreshSession).
  const [rows] = await pool.query(
    `SELECT m.*, a.name AS accountName, a.id AS accId
     FROM members m JOIN accounts a ON m.account_id = a.id
     WHERE m.email=? AND m.status='active'`,
    [email]
  )
  const allAccountIds = [...new Set(rows.map(r => r.accId))]
  // La cuenta activa es aquella cuya credencial se validó (donde el usuario "entró").
  const first         = authRows[0]
  const [roleRows]    = await pool.query('SELECT * FROM roles WHERE id=?', [first.role_id])
  const role          = roleRows[0]
  return {
    type: 'member', id: first.id, name: first.name, email: first.email, photo: first.photo || null,
    accountId: first.accId, accountName: first.accountName,
    allAccountIds,
    roleId: first.role_id, permissions: parseJ(role?.permissions, {}),
    agentAccess: parseJ(first.agent_access, []),
  }
}

// ¿Está activo el 2FA de login? Solo si el super admin lo activó Y hay correo configurado.
async function twoFactorActive() {
  try {
    const [[s]] = await pool.query('SELECT login_2fa_enabled FROM platform_settings WHERE id=1')
    if (!s || !s.login_2fa_enabled) return false
    return isConfigured(await loadEmailConfig())
  } catch { return false }
}

const login = async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' })
  try {
    const session = await buildSessionFor(email, password)
    if (!session) return res.status(401).json({ error: 'Credenciales inválidas' })

    // 2FA opt-in: si está activo y la identidad tiene correo, se envía un código y
    // NO se entrega el token hasta verificarlo. Si el envío falla, se hace fail-open
    // (se entrega el token igual) para no dejar a nadie fuera por un problema de correo.
    if (session.email && await twoFactorActive()) {
      const r = await issueCode(session.email, 'login')
      if (r.ok) return res.json({ twoFactorRequired: true, email: session.email })
      console.error('[LOGIN 2FA] envío falló, fail-open:', r.error)
    }
    res.json({ token: sign(session), session })
  } catch (err) {
    console.error('[LOGIN]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// Segundo paso del 2FA: revalida credenciales + verifica el código → entrega token.
const verify2fa = async (req, res) => {
  const { email, password, code } = req.body
  if (!email || !password || !code) return res.status(400).json({ error: 'Faltan datos' })
  try {
    const session = await buildSessionFor(email, password)
    if (!session) return res.status(401).json({ error: 'Credenciales inválidas' })
    const v = await verifyCode(session.email, 'login', code)
    if (!v.ok) return res.status(401).json({ error: v.error })
    res.json({ token: sign(session), session })
  } catch (err) {
    console.error('[VERIFY 2FA]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// Reenvía el código de login (mismo correo).
const resend2fa = async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Faltan datos' })
  try {
    const session = await buildSessionFor(email, password)
    if (!session) return res.status(401).json({ error: 'Credenciales inválidas' })
    const r = await issueCode(session.email, 'login')
    if (!r.ok) return res.status(503).json({ error: r.error })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
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
    // Identidad FRESCA del super admin logueado (desde la BD por su id), por si el token
    // trae datos viejos. Hay varios super admins: cada uno entra en la vista con SU correo
    // y nombre, no con una cuenta genérica.
    const [[sa]] = await pool.query('SELECT id, name, email, photo FROM super_admins WHERE id=?', [req.user.id])
    const saId    = sa?.id    || req.user.id
    const saName  = sa?.name  || req.user.name  || 'Super Admin'
    const saEmail = sa?.email || req.user.email || ''
    const saPhoto = sa?.photo || req.user.photo || null
    // Cuentas a las que el super admin PERTENECE (donde es miembro activo con su correo),
    // más la cuenta que está abriendo. Así el selector "cambiar cuenta" muestra todas.
    let allAccountIds = [accountId]
    if (saEmail) {
      const [memberAccts] = await pool.query("SELECT DISTINCT account_id FROM members WHERE email=? AND status='active'", [saEmail])
      allAccountIds = [...new Set([accountId, ...memberAccts.map(r => r.account_id)])]
    }
    // Modo VISTA: el super admin entra con SU PROPIA identidad. No es una impersonación
    // genérica: el perfil muestra a su usuario super admin real. `isImpersonating` solo
    // activa la barra de "vista" y el botón Volver.
    const session = {
      type: 'member', id: saId, name: saName, email: saEmail, photo: saPhoto,
      accountId, accountName: acc.name,
      roleId: 'role_owner', allAccountIds,
      permissions: { inbox:true, agents:true, channels:true, crm:true, pipeline:true, config:true, admins:true, flows:true, variables:true, tools:true, knowledge:true },
      agentAccess: [], isImpersonating: true,
      // Identidad del super admin que está en la vista (para acciones que la necesitan).
      saId, saEmail, saName,
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
      type: 'member', id: active.id, name: active.name, email: active.email, photo: active.photo || null,
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

// Autoservicio: el usuario edita su PROPIO perfil (nombre, foto, correo,
// contraseña). La identidad de un miembro es su email (puede pertenecer a varias
// cuentas), así que los cambios se aplican a todas sus filas.
const updateMyProfile = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' })
  const { name, email, photo, currentPassword, newPassword } = req.body || {}
  const isSA = req.user.type === 'superadmin'
  const table = isSA ? 'super_admins' : 'members'
  try {
    // Fila(s) actuales del usuario
    const [rows] = isSA
      ? await pool.query('SELECT * FROM super_admins WHERE id=?', [req.user.id])
      : await pool.query('SELECT * FROM members WHERE email=?', [req.user.email])
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' })
    const me = rows[0]

    // Cambio de contraseña: exige la actual
    if (newPassword) {
      if ((currentPassword || '') !== (me.password || '')) return res.status(400).json({ error: 'La contraseña actual no coincide' })
      if (String(newPassword).length < 4) return res.status(400).json({ error: 'La nueva contraseña es muy corta' })
    }
    // Cambio de email: único (no debe existir en members ni super_admins salvo yo)
    const newEmail = (email || '').trim().toLowerCase()
    if (newEmail && newEmail !== (me.email || '').toLowerCase()) {
      const [[dupM]] = await pool.query('SELECT id FROM members WHERE email=? LIMIT 1', [newEmail])
      const [[dupS]] = await pool.query('SELECT id FROM super_admins WHERE email=? LIMIT 1', [newEmail])
      if ((dupM && !isSA) || (dupS && isSA) || (dupM && isSA) || (dupS && !isSA)) return res.status(409).json({ error: 'Ese correo ya está en uso' })
    }

    const sets = [], vals = []
    if (name !== undefined) { sets.push('name=?'); vals.push(name) }
    if (photo !== undefined) { sets.push('photo=?'); vals.push(photo || null) }
    if (newEmail) { sets.push('email=?'); vals.push(newEmail) }
    if (newPassword) { sets.push('password=?'); vals.push(newPassword) }
    if (sets.length) {
      if (isSA) await pool.query(`UPDATE super_admins SET ${sets.join(',')} WHERE id=?`, [...vals, req.user.id])
      else await pool.query(`UPDATE members SET ${sets.join(',')} WHERE email=?`, [...vals, req.user.email])
    }

    // Re-firma la sesión con los datos nuevos (mantiene cuenta/rol/permisos)
    const session = {
      ...req.user,
      name: name !== undefined ? name : req.user.name,
      email: newEmail || req.user.email,
      photo: photo !== undefined ? (photo || null) : (req.user.photo || null),
    }
    res.json({ token: sign(session), session })
  } catch (err) {
    console.error('[PROFILE]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = { login, verify2fa, resend2fa, switchAccount, impersonate, refreshSession, updateMyProfile }
