'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/apiKeys.controller')

router.get('/accounts/:accId/api-keys',           authMiddleware, ctrl.list)
router.post('/accounts/:accId/api-keys',          authMiddleware, ctrl.create)
router.delete('/accounts/:accId/api-keys/:id',    authMiddleware, ctrl.remove)

module.exports = router
