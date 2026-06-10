'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/flowLogs.controller')

router.get('/accounts/:accId/flow-executions', authMiddleware, ctrl.listExecutions)
router.get('/accounts/:accId/error-log',        authMiddleware, ctrl.listErrors)

module.exports = router
