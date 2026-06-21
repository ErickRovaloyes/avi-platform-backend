'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/woocommerce.controller')

// Configuración de la conexión (autenticado: owner de la cuenta).
router.get('/woocommerce/:accId/config',  authMiddleware, ctrl.getConfig)
router.put('/woocommerce/:accId/config',  authMiddleware, ctrl.saveConfig)
router.post('/woocommerce/:accId/test',   authMiddleware, ctrl.testConnection)

// Proxy usado por el asistente (webchat-en-navegador y motor): NO expone llaves.
router.post('/woocommerce/:accId/products', ctrl.products)
router.post('/woocommerce/:accId/order',    ctrl.createOrder)

// Webhook de WooCommerce (order.updated) → confirma el pago en el chat.
router.post('/woocommerce/webhook/:accId',  ctrl.webhook)

module.exports = router
