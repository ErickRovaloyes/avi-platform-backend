'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/payments.controller')

// Configuración de la pasarela (autenticado: owner de la cuenta).
router.get('/payments/:accId/config',  authMiddleware, ctrl.getConfig)
router.put('/payments/:accId/config',  authMiddleware, ctrl.saveConfig)
router.post('/payments/:accId/test',   authMiddleware, ctrl.testConnection)

// Proxy usado por el asistente (webchat-en-navegador y motor): NO expone llaves.
router.post('/payments/:accId/link',    ctrl.createLink)
router.post('/payments/:accId/status',  ctrl.status)

// Webhook del proveedor (Wompi …) → confirma el pago y dispara el flujo.
router.post('/payments/webhook/:accId', ctrl.webhook)

module.exports = router
