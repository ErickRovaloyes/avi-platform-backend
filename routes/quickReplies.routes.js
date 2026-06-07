'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/quickReplies.controller')

router.get('/accounts/:accId/quick-replies',           authMiddleware, ctrl.list)
router.post('/accounts/:accId/quick-replies',          authMiddleware, ctrl.create)
router.put('/accounts/:accId/quick-replies/:id',       authMiddleware, ctrl.update)
router.delete('/accounts/:accId/quick-replies/:id',    authMiddleware, ctrl.remove)

module.exports = router
