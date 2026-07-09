'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/promptHistory.controller')

router.post('/accounts/:accId/change-agent/apply',     authMiddleware, ctrl.applyChange)
router.post('/accounts/:accId/prompt-history',         authMiddleware, ctrl.createEntry)
router.get('/accounts/:accId/prompt-history',          authMiddleware, ctrl.listEntries)
router.get('/accounts/:accId/prompt-history/:id',      authMiddleware, ctrl.getEntry)

module.exports = router
