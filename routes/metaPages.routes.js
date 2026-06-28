'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/metaPages.controller')

// Conexión 1-clic de Messenger / Instagram (long-lived token + suscripción de webhooks).
router.post('/meta/pages/connect', authMiddleware, ctrl.connect)

module.exports = router
