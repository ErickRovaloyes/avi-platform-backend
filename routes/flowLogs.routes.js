'use strict'
const router = require('express').Router()
const { authMiddleware, optionalAuth } = require('../auth')
const ctrl = require('../controllers/flowLogs.controller')

router.get('/accounts/:accId/flow-executions', authMiddleware, ctrl.listExecutions)
router.get('/accounts/:accId/error-log',        authMiddleware, ctrl.listErrors)
// Los flujos del NAVEGADOR (pruebas/webchat) registran su ejecución aquí.
// optionalAuth: el webchat público (sin JWT) también ejecuta flujos.
router.post('/accounts/:accId/flow-executions', optionalAuth, ctrl.createExecution)

module.exports = router
