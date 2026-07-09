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

// Proxy del asistente (webchat-en-navegador y motor): mismo patrón que scheduling.
router.post('/pms/:accId/tool',  ctrl.tool)

module.exports = router
