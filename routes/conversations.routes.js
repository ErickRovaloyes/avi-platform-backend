'use strict'
const router = require('express').Router()
const { optionalAuth, authMiddleware } = require('../auth')
const ctrl = require('../controllers/conversations.controller')

router.post('/guest',                                   ctrl.getGuest)
router.get('/:accId/:agId',                             optionalAuth, ctrl.listConvos)
router.get('/:accId/:agId/:convId',                     optionalAuth, ctrl.getConvo)
router.post('/:accId/:agId',                            optionalAuth, ctrl.createConvo)
router.put('/:accId/:agId/:convId',                     optionalAuth, ctrl.updateConvo)
router.put('/:accId/:agId/:convId/read',                optionalAuth, ctrl.markRead)
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
