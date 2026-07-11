'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/campaigns.controller')

router.get('/accounts/:accId/campaigns',                 authMiddleware, ctrl.list)
router.get('/accounts/:accId/campaigns/best-time',       authMiddleware, ctrl.bestTime)
router.get('/accounts/:accId/campaigns/:id/roi',         authMiddleware, ctrl.roi)
router.get('/accounts/:accId/campaigns/:id/ab',          authMiddleware, ctrl.abResults)
router.post('/accounts/:accId/campaigns/preview',        authMiddleware, ctrl.preview)
router.post('/accounts/:accId/campaigns',                authMiddleware, ctrl.create)
router.put('/accounts/:accId/campaigns/:id',             authMiddleware, ctrl.update)
router.post('/accounts/:accId/campaigns/:id/send',       authMiddleware, ctrl.sendNow)
router.post('/accounts/:accId/campaigns/:id/resend',     authMiddleware, ctrl.resend)
router.post('/accounts/:accId/campaigns/:id/cancel',     authMiddleware, ctrl.cancel)
router.delete('/accounts/:accId/campaigns/:id',          authMiddleware, ctrl.remove)

module.exports = router
