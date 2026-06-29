'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/promptOptimizer.controller')

router.get('/accounts/:accId/agents/:agId/optimizer/status',      authMiddleware, ctrl.status)
router.post('/accounts/:accId/agents/:agId/optimizer/run',        authMiddleware, ctrl.run)
router.get('/accounts/:accId/agents/:agId/optimizer/suggestions', authMiddleware, ctrl.suggestions)

module.exports = router
