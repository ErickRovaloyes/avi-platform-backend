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
router.post('/woocommerce/:accId/order-status', ctrl.orderStatus)

// Pestaña "Productos" del panel (autenticado): listar + editar en la tienda.
router.get('/woocommerce/:accId/all-products',          authMiddleware, ctrl.listProducts)
router.put('/woocommerce/:accId/products/:productId',   authMiddleware, ctrl.updateProduct)

// Webhook de WooCommerce (order.updated) → confirma el pago en el chat.
router.post('/woocommerce/webhook/:accId',  ctrl.webhook)

// ── Índice vectorial de productos (búsqueda inteligente de la IA) ──────────────
const pix = require('../controllers/productIndex.controller')
router.get('/woocommerce/:accId/vector-index',          authMiddleware, pix.vectorStatus)
router.put('/woocommerce/:accId/vector-index',          authMiddleware, pix.vectorSaveSettings)
router.post('/woocommerce/:accId/vector-index/sync',    authMiddleware, pix.vectorSyncNow)
router.post('/woocommerce/:accId/vector-index/search',  authMiddleware, pix.vectorTestSearch)
// Receivers de webhooks de producto (públicos; verificados por HMAC).
router.post('/woocommerce/product-webhook/:accId',  pix.wooProductWebhook)
router.post('/shopify/product-webhook/:accId',      pix.shopifyProductWebhook)

module.exports = router
