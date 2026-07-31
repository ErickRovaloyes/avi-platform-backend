'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/billing.controller')

// Facturación del dueño (autoservicio).
router.get('/billing/catalog',      authMiddleware, ctrl.getCatalog)
router.get('/billing/fx',           authMiddleware, ctrl.getFx)
router.get('/billing/subscription', authMiddleware, ctrl.getMySubscription)
router.get('/billing/gateways',     authMiddleware, ctrl.getGateways)
router.post('/billing/checkout',    authMiddleware, ctrl.checkout)
// Webhooks de pasarela (sin auth; firma verificada). Cuerpo crudo capturado en index.js (req.rawBody).
router.post('/billing/webhook/stripe', ctrl.webhookStripe)
router.post('/billing/webhook/wompi',  ctrl.webhookWompi)

module.exports = router
