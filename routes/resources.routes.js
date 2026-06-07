'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/resources.controller')

// ── Variables ─────────────────────────────────────────────────────────────────
router.post('/accounts/:accId/variables',               authMiddleware, ctrl.createVariable)
router.put('/accounts/:accId/variables/:varId',         authMiddleware, ctrl.updateVariable)
router.delete('/accounts/:accId/variables/:varId',      authMiddleware, ctrl.deleteVariable)
router.post('/variables/:accId',                        authMiddleware, ctrl.createVariable)
router.put('/variables/:accId/:varId',                  authMiddleware, ctrl.updateVariable)
router.delete('/variables/:accId/:varId',               authMiddleware, ctrl.deleteVariable)

// ── AI Tools ──────────────────────────────────────────────────────────────────
router.post('/accounts/:accId/ai-tools',                authMiddleware, ctrl.createAITool)
router.put('/accounts/:accId/ai-tools/:toolId',         authMiddleware, ctrl.updateAITool)
router.delete('/accounts/:accId/ai-tools/:toolId',      authMiddleware, ctrl.deleteAITool)
router.post('/ai_tools/:accId',                         authMiddleware, ctrl.createAITool)
router.put('/ai_tools/:accId/:toolId',                  authMiddleware, ctrl.updateAITool)
router.delete('/ai_tools/:accId/:toolId',               authMiddleware, ctrl.deleteAITool)

// ── Flows ─────────────────────────────────────────────────────────────────────
router.post('/accounts/:accId/flows',                   authMiddleware, ctrl.createFlow)
router.put('/accounts/:accId/flows/:flowId',            authMiddleware, ctrl.updateFlow)
router.delete('/accounts/:accId/flows/:flowId',         authMiddleware, ctrl.deleteFlow)
router.post('/flows/:accId',                            authMiddleware, ctrl.createFlow)
router.put('/flows/:accId/:flowId',                     authMiddleware, ctrl.updateFlow)
router.delete('/flows/:accId/:flowId',                  authMiddleware, ctrl.deleteFlow)

module.exports = router
