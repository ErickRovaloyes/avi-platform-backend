'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/pms.controller')

// Configuración (autenticado): proveedor + token del PMS.
router.get('/pms/:accId/config', authMiddleware, ctrl.getConfig)
router.put('/pms/:accId/config', authMiddleware, ctrl.saveConfig)
router.post('/pms/:accId/test',  authMiddleware, ctrl.test)
router.post('/pms/:accId/reset', authMiddleware, ctrl.resetCredentials)

// Proxy del asistente (webchat-en-navegador y motor): mismo patrón que scheduling.
router.post('/pms/:accId/tool',  ctrl.tool)

module.exports = router
