'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/metaPages.controller')

// Conexión 1-clic de Messenger / Instagram (long-lived token + suscripción de webhooks).
router.post('/meta/pages/connect', authMiddleware, ctrl.connect)
// Suscribe una página a los webhooks de la app (para la conexión MANUAL).
router.post('/meta/pages/subscribe', authMiddleware, ctrl.subscribe)

module.exports = router
