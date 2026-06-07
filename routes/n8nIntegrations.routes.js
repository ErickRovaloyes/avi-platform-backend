'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/n8nIntegrations.controller')

router.get('/n8n/integrations',                authMiddleware, ctrl.list)
router.post('/n8n/integrations',               authMiddleware, ctrl.create)
router.put('/n8n/integrations/:id',            authMiddleware, ctrl.update)
router.delete('/n8n/integrations/:id',         authMiddleware, ctrl.remove)
router.post('/n8n/integrations/:id/test',      authMiddleware, ctrl.test)
router.post('/n8n/integrations/:id/dispatch',  authMiddleware, ctrl.dispatch)

module.exports = router
