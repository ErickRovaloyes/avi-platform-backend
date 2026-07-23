'use strict'
const router = require('express').Router()
const ctrl = require('../controllers/webhooks.controller')

// Webhooks GLOBALES de la app de Meta (1-clic): una sola URL por producto para TODOS
// los clientes; se enruta por phone_number_id (WhatsApp) / pageId (Messenger) / igId
// (Instagram). El POST global es unificado: enruta por `object`, así funciona sin
// importar qué producto del panel de Meta apunte a cada URL. DEBEN ir ANTES que las
// rutas con params.
router.get('/webhook/whatsapp',                     ctrl.whatsappVerify)
router.post('/webhook/whatsapp',                    ctrl.metaReceiveGlobal)
router.get('/webhook/messenger',                    ctrl.messengerVerify)
router.post('/webhook/messenger',                   ctrl.metaReceiveGlobal)
router.get('/webhook/instagram',                    ctrl.instagramVerify)
router.post('/webhook/instagram',                   ctrl.metaReceiveGlobal)
// Rutas POR-AGENTE (app propia del cliente / retrocompatibilidad).
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
