'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/notifications.controller')

router.get('/accounts/:accId/notifications',              authMiddleware, ctrl.list)
router.post('/accounts/:accId/notifications',             authMiddleware, ctrl.create)
router.put('/accounts/:accId/notifications/read-all',     authMiddleware, ctrl.markAllRead)
router.put('/accounts/:accId/notifications/:id/read',     authMiddleware, ctrl.markRead)
router.delete('/accounts/:accId/notifications/:id',       authMiddleware, ctrl.remove)
router.delete('/accounts/:accId/notifications',           authMiddleware, ctrl.clear)

module.exports = router
