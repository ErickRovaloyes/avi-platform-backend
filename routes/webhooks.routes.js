'use strict'
const router = require('express').Router()
const ctrl = require('../controllers/webhooks.controller')

router.get('/webhook/whatsapp/:accId/:agentId',     ctrl.whatsappVerify)
router.post('/webhook/whatsapp/:accId/:agentId',    ctrl.whatsappReceive)
router.get('/webhook/messenger/:accId/:agentId',    ctrl.messengerVerify)
router.post('/webhook/messenger/:accId/:agentId',   ctrl.messengerReceive)
router.get('/webhook/instagram/:accId/:agentId',    ctrl.instagramVerify)
router.post('/webhook/instagram/:accId/:agentId',   ctrl.instagramReceive)
router.get('/whatsapp/events',                      ctrl.sseStream)
router.post('/test-message',                        ctrl.testMessage)
router.get('/debug',                                ctrl.getDebug)
router.get('/health',                               ctrl.getHealth)

module.exports = router
