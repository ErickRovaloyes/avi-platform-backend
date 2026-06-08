'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/whatsappTemplates.controller')

router.get('/whatsapp/:accId/:agentId/templates',      authMiddleware, ctrl.list)
router.post('/whatsapp/:accId/:agentId/send-template', authMiddleware, ctrl.send)

module.exports = router
