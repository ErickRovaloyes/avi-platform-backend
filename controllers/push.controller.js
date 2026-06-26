'use strict'
const push = require('../services/push')

// POST /api/push/register  { token, platform }  (autenticado)
const register = async (req, res) => {
  const { token, platform } = req.body || {}
  if (!token) return res.status(400).json({ error: 'token requerido' })
  const accId = req.user?.accountId
  if (!accId) return res.status(400).json({ error: 'Sesión sin cuenta' })
  try {
    await push.registerToken(accId, req.user?.id, token, platform)
    res.json({ ok: true })
  } catch (e) { console.error('[push register]', e.message); res.status(500).json({ error: 'Error interno' }) }
}

// POST /api/push/unregister  { token }  (al cerrar sesión)
const unregister = async (req, res) => {
  try { if (req.body?.token) await push.removeToken(req.body.token); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { register, unregister }
