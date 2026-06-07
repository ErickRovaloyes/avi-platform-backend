'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/analytics.controller')

// ── Token usage ──────────────────────────────────────────────────────────────
router.post('/accounts/:accId/token-usage',  authMiddleware, ctrl.recordUsage)
router.get('/accounts/:accId/token-usage',   authMiddleware, ctrl.queryUsage)

// ── Business metrics ────────────────────────────────────────────────────────
router.get('/accounts/:accId/metrics',       authMiddleware, ctrl.businessMetrics)

// ── Model pricing (super admin manages, anyone authed can read) ─────────────
router.get('/model-pricing',                 authMiddleware, ctrl.listPricing)
router.put('/model-pricing/:model',          authMiddleware, ctrl.updatePricing)
router.delete('/model-pricing/:model',       authMiddleware, ctrl.deletePricing)

module.exports = router
