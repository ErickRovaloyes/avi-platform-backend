'use strict'
const router = require('express').Router()
const { optionalAuth, authMiddleware } = require('../auth')
const ctrl = require('../controllers/conversations.controller')
const pool = require('../db')
const visibilidad = require('../services/visibilidadConvos')

/**
 * No se puede escribir en un chat que no se puede ver.
 *
 * Solo actúa cuando la sesión es un miembro con `soloAsignadas`. El invitado del webchat llega
 * SIN sesión a varias de estas rutas (leer su chat, mandar su mensaje, guardar variables), así
 * que cualquier comprobación incondicional lo dejaría fuera de su propia conversación.
 */
async function soloSiPuedeVer(req, res, next, convId) {
  if (!visibilidad.estaRestringido(req.user)) return next()
  const { accId } = req.params
  try {
    const [[c]] = await pool.query('SELECT assigned_to, team_id FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada' })
    const equipos = await visibilidad.equiposDe(accId, req.user.id)
    if (!visibilidad.puedeVer(c, req.user, equipos)) return res.status(404).json({ error: 'Conversación no encontrada' })
    next()
  } catch (err) {
    console.error('[soloSiPuedeVer]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// `router.param` y no `router.use`: con un prefijo, `/:accId/:agId/:convId` tambien atraparia
// `/:accId/:agId/whatsapp`, donde el tercer segmento NO es una conversacion — y crear un chat
// de WhatsApp acabaria en un 404 buscando una conversacion llamada "whatsapp".
router.param('convId', soloSiPuedeVer)

router.post('/guest',                                   ctrl.getGuest)
router.get('/:accId/:agId',                             optionalAuth, ctrl.listConvos)
router.get('/:accId/:agId/:convId',                     optionalAuth, ctrl.getConvo)
router.post('/:accId/:agId',                            optionalAuth, ctrl.createConvo)
router.put('/:accId/:agId/:convId',                     optionalAuth, ctrl.updateConvo)
router.put('/:accId/:agId/:convId/read',                optionalAuth, ctrl.markRead)
// Ejecutar un flujo a mano sobre la conversación. Exige sesión: dispara acciones reales
// (mensajes al cliente, tickets, cobros), así que no puede quedar abierto como el webchat.
router.post('/:accId/:agId/:convId/run-flow',           authMiddleware, ctrl.runFlowManually)
router.post('/:accId/:agId/:convId/messages',           optionalAuth, ctrl.appendMessage)
router.post('/:accId/:agId/:convId/send-manual',        optionalAuth, ctrl.sendManual)
router.post('/:accId/:agId/:convId/suggest-reply',      optionalAuth, ctrl.suggestReply)
router.post('/:accId/:agId/:convId/debug',              optionalAuth, ctrl.appendDebug)
// Mensajes destacados del chat (solo asesores autenticados; el widget no los usa).
router.get('/:accId/:agId/:convId/starred',             authMiddleware, ctrl.listStarred)
router.put('/:accId/:agId/:convId/messages/:msgId/star', authMiddleware, ctrl.starMessage)
router.patch('/:accId/:agId/:convId/vars',              optionalAuth, ctrl.patchVars)
router.post('/:accId/:agId/:convId/memory',             optionalAuth, ctrl.updateMemory)
router.post('/:accId/:agId/whatsapp',                   optionalAuth, ctrl.createWhatsApp)
router.post('/:accId/:agId/messenger',                  optionalAuth, ctrl.createMessenger)
router.post('/:accId/:agId/instagram',                  optionalAuth, ctrl.createInstagram)
router.post('/:accId/:agId/social',                     optionalAuth, ctrl.createSocial)
router.delete('/:accId/:agId/:convId',                  optionalAuth, ctrl.deleteConvo)

module.exports = router
