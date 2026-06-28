'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/teamchat.controller')

// Channels & DMs — must be declared before the generic /:accId routes
router.get('/:accId/channels',          authMiddleware, ctrl.listChannels)
router.post('/:accId/channels',         authMiddleware, ctrl.createChannel)
router.delete('/:accId/channels/:chId', authMiddleware, ctrl.deleteChannel)
router.post('/:accId/dm',               authMiddleware, ctrl.openDM)
// Supervisión superadmin: resumen de chats privados directos
router.get('/:accId/dms-overview',      authMiddleware, ctrl.dmsOverview)

// Messages
router.get('/:accId',   authMiddleware, ctrl.getMessages)
router.post('/:accId',  authMiddleware, ctrl.postMessage)

module.exports = router
