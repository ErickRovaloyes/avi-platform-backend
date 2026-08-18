'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/octorate.controller')

// Con sesion: solo el dueno conecta o reactiva.
router.post('/accounts/:accId/octorate/authorize', authMiddleware, ctrl.iniciarOauth)
router.post('/accounts/:accId/octorate/webhooks',  authMiddleware, ctrl.reactivarAvisos)

// SIN sesion: las llama Octorate. La vuelta del OAuth trae su `state`, y el webhook un secreto
// en la propia URL, porque Octorate no firma sus notificaciones.
router.get('/octorate/callback', ctrl.callbackOauth)
router.post('/octorate/webhook/:accId/:secreto', ctrl.webhook)

module.exports = router
