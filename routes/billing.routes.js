'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/billing.controller')

// Facturación del dueño (autoservicio). Checkout + webhooks llegan en la Etapa 3.
router.get('/billing/catalog',      authMiddleware, ctrl.getCatalog)
router.get('/billing/fx',           authMiddleware, ctrl.getFx)
router.get('/billing/subscription', authMiddleware, ctrl.getMySubscription)

module.exports = router
