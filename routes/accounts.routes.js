'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/accounts.controller')

router.get('/public/:accId',                                    ctrl.getPublicAccount)
router.get('/:accId',                                           authMiddleware, ctrl.getAccount)
router.put('/:accId',                                           authMiddleware, ctrl.updateAccount)
router.get('/:accId/change-agent-usage',                        authMiddleware, ctrl.getChangeAgentUsage)
router.post('/:accId/change-agent-usage',                       authMiddleware, ctrl.incrementChangeAgentUsage)
router.post('/:accId/change-agent-usage/increment',             authMiddleware, ctrl.incrementChangeAgentUsage)
router.get('/:accId/effective-keys',                            authMiddleware, ctrl.getEffectiveKeys)

module.exports = router
