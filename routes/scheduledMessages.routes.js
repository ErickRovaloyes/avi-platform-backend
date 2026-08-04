'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/scheduledMessages.controller')

router.get('/accounts/:accId/scheduled-messages',        authMiddleware, ctrl.list)
router.post('/accounts/:accId/scheduled-messages',       authMiddleware, ctrl.create)
router.delete('/accounts/:accId/scheduled-messages/:id', authMiddleware, ctrl.cancel)

module.exports = router
