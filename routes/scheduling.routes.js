'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/scheduling.controller')

// Configuración (autenticado): calendarios que el asistente puede usar.
router.get('/scheduling/:accId/config',  authMiddleware, ctrl.getConfig)
router.put('/scheduling/:accId/config',  authMiddleware, ctrl.saveConfig)

// Proxy del asistente (webchat-en-navegador y motor): ver/agendar/mover/cancelar.
router.post('/scheduling/:accId/tool',   ctrl.tool)

module.exports = router
