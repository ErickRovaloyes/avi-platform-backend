'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/pms.controller')

// Configuración (autenticado): proveedor + token del PMS.
router.get('/pms/:accId/config', authMiddleware, ctrl.getConfig)
router.put('/pms/:accId/config', authMiddleware, ctrl.saveConfig)
router.post('/pms/:accId/test',  authMiddleware, ctrl.test)
router.post('/pms/:accId/reset', authMiddleware, ctrl.resetCredentials)

// Lectura para la UI (subpestañas Propiedades / Disponibilidad).
router.get('/pms/:accId/properties',         authMiddleware, ctrl.listProperties)
router.get('/pms/:accId/rooms',              authMiddleware, ctrl.listRooms)
router.get('/pms/:accId/availability',       authMiddleware, ctrl.availability)
router.get('/pms/:accId/availability/month', authMiddleware, ctrl.monthAvailability)
router.get('/pms/:accId/debug',              authMiddleware, ctrl.debug)

// Proxy del asistente (webchat-en-navegador y motor): mismo patrón que scheduling.
router.post('/pms/:accId/tool',  ctrl.tool)

// Índice vectorial de alojamientos: MISMO controlador que la tienda y el catálogo de Meta,
// con la fuente fijada a `pms`. El motor del índice no sabe de hoteles; solo cambia de dónde
// sale el catálogo (services/pms.js → listRoomsForIndex).
const pix = require('../controllers/productIndex.controller')
const pmsSrc = (req, _res, next) => { req.query.source = 'pms'; next() }
router.get('/pms/:accId/vector-index',         authMiddleware, pmsSrc, pix.vectorStatus)
router.put('/pms/:accId/vector-index',         authMiddleware, pmsSrc, pix.vectorSaveSettings)
router.post('/pms/:accId/vector-index/sync',   authMiddleware, pmsSrc, pix.vectorSyncNow)
router.post('/pms/:accId/vector-index/search', authMiddleware, pmsSrc, pix.vectorTestSearch)

module.exports = router
