'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/agents.controller')

// ── Agent CRUD (under /api/accounts/:accId) ───────────────────────────────────
router.post('/accounts/:accId/agents',                              authMiddleware, ctrl.createAgent)
router.put('/accounts/:accId/agents/:agId',                         authMiddleware, ctrl.updateAgent)
router.delete('/accounts/:accId/agents/:agId',                      authMiddleware, ctrl.deleteAgent)

// ── Agent alias paths (used by AccountContext) ────────────────────────────────
router.put('/agents/:accId/:agId',                                  authMiddleware, ctrl.updateAgent)
router.delete('/agents/:accId/:agId',                               authMiddleware, ctrl.deleteAgent)

// ── Channels ──────────────────────────────────────────────────────────────────
router.get('/agents/:accId/:agId/channels',                         authMiddleware, ctrl.getChannels)
router.post('/agents/:accId/:agId/channels',                        authMiddleware, ctrl.createChannel)
router.put('/agents/:accId/:agId/channels/:channelId',              authMiddleware, ctrl.updateChannel)
router.delete('/agents/:accId/:agId/channels/:channelId',           authMiddleware, ctrl.deleteChannel)

// ── Prompts ───────────────────────────────────────────────────────────────────
router.post('/agents/:accId/:agId/prompts',                         authMiddleware, ctrl.createPrompt)
router.put('/agents/:accId/:agId/prompts/:promptId',                authMiddleware, ctrl.updatePrompt)
router.delete('/agents/:accId/:agId/prompts/:promptId',             authMiddleware, ctrl.deletePrompt)

module.exports = router
