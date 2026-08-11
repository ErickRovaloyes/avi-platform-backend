'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/instagramOauth.controller')

// `start` exige sesión: es quien emite el `state` firmado.
router.get('/instagram/oauth/start', authMiddleware, ctrl.start)
// `callback` NO puede exigirla: lo invoca el navegador al volver de Instagram, sin cabeceras
// propias. Lo que autentica la petición es el `state` firmado que emitió `start`.
router.get('/instagram/oauth/callback', ctrl.callback)

module.exports = router
