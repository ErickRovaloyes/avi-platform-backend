'use strict'
/**
 * Entorno de pruebas de una cuenta: crear, rehacer y eliminar.
 * El acceso lo da la copia de miembros (ver services/sandbox.js): no hace falta tocar el login.
 */
const sandbox = require('../services/sandbox')
const socket = require('../services/socket')

// Solo el dueño de la cuenta (o un super admin) monta o tira el entorno de pruebas: es una
// cuenta entera, no un ajuste.
function puedeGestionar(user, accId) {
  if (!user) return 'No hay sesión.'
  if (user.type === 'superadmin' || user.isImpersonating) return null
  if (user.type !== 'member') return 'No tienes acceso a esta cuenta.'
  if (String(user.accountId) !== String(accId)) return 'Esta cuenta no es la tuya.'
  if (!String(user.roleId || '').startsWith('role_owner')) return 'Solo el dueño de la cuenta puede gestionar el entorno de pruebas.'
  return null
}

const getInfo = async (req, res) => {
  try {
    const info = await sandbox.infoDe(req.params.accId)
    if (!info) return res.status(404).json({ error: 'La cuenta no existe.' })
    res.json(info)
  } catch (err) { console.error('[sandbox info]', err); res.status(500).json({ error: 'Error interno' }) }
}

const crear = async (req, res) => {
  const { accId } = req.params
  const error = puedeGestionar(req.user, accId)
  if (error) return res.status(403).json({ error })
  try {
    const r = await sandbox.crearOrehacer(accId, { limpiarChats: !!req.body?.limpiarChats })
    // La sesión tiene que enterarse de que hay una cuenta más a la que puede entrar.
    socket.emit(accId, 'account:updated', { accId })
    res.json(r)
  } catch (err) {
    console.error('[sandbox crear]', err)
    res.status(400).json({ error: err.message || 'No se pudo preparar el entorno de pruebas' })
  }
}

const eliminar = async (req, res) => {
  const { accId } = req.params
  const error = puedeGestionar(req.user, accId)
  if (error) return res.status(403).json({ error })
  try {
    const r = await sandbox.eliminar(accId)
    socket.emit(accId, 'account:updated', { accId })
    res.json(r)
  } catch (err) { console.error('[sandbox eliminar]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { getInfo, crear, eliminar }
