'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/metaPages.controller')

// Conexión 1-clic de Messenger / Instagram (long-lived token + suscripción de webhooks).
router.post('/meta/pages/connect', authMiddleware, ctrl.connect)
// Suscribe una página a los webhooks de la app (para la conexión MANUAL).
router.post('/meta/pages/subscribe', authMiddleware, ctrl.subscribe)
// Diagnóstico de la cadena de recepción: dice qué eslabón impide que lleguen los mensajes.
router.post('/meta/pages/diagnose', authMiddleware, ctrl.diagnose)
// Por qué no llega ninguna Página (antes de conectar ninguna).
router.post('/meta/pages/diagnose-connect', authMiddleware, ctrl.diagnoseConnect)

module.exports = router
