'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/orders.controller')

// Configuración del módulo (autenticado).
router.get('/orders/:accId/config',  authMiddleware, ctrl.getConfig)
router.put('/orders/:accId/config',  authMiddleware, ctrl.saveConfig)

// Menú / catálogo, zonas y repartidores (autenticado).
router.get('/orders/:accId/menu',              authMiddleware, ctrl.listMenu)
router.post('/orders/:accId/products',         authMiddleware, ctrl.saveProduct)
router.delete('/orders/:accId/products/:id',   authMiddleware, ctrl.deleteProduct)
router.post('/orders/:accId/groups',           authMiddleware, ctrl.saveGroup)
router.delete('/orders/:accId/groups/:id',     authMiddleware, ctrl.deleteGroup)
router.post('/orders/:accId/zones',            authMiddleware, ctrl.saveZone)
router.delete('/orders/:accId/zones/:id',      authMiddleware, ctrl.deleteZone)
router.post('/orders/:accId/couriers',         authMiddleware, ctrl.saveCourier)
router.delete('/orders/:accId/couriers/:id',   authMiddleware, ctrl.deleteCourier)
router.post('/orders/:accId/coupons',          authMiddleware, ctrl.saveCoupon)
router.delete('/orders/:accId/coupons/:id',    authMiddleware, ctrl.deleteCoupon)

// Tablero operativo (autenticado).
router.get('/orders/:accId/orders',            authMiddleware, ctrl.listOrders)
router.get('/orders/:accId/orders/:id',        authMiddleware, ctrl.getOrder)
router.put('/orders/:accId/orders/:id',        authMiddleware, ctrl.updateOrder)

// Proxy del asistente (webchat-en-navegador y motor): mismo patrón que scheduling/pms.
router.post('/orders/:accId/tool',             ctrl.tool)
// Seguimiento público del pedido por código (sin auth, rate-limited).
router.get('/orders/:accId/track/:code',       ctrl.track)

module.exports = router
