'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/google.controller')

// Callback de Google: SIN auth (Google redirige aquí con ?code&state)
router.get('/google/callback', ctrl.callback)

// Resto: requieren sesión
router.get('/accounts/:accId/google/status',        authMiddleware, ctrl.status)
router.get('/accounts/:accId/google/auth-url',      authMiddleware, ctrl.authUrl)
router.delete('/accounts/:accId/google',            authMiddleware, ctrl.disconnect)
router.get('/accounts/:accId/google/sheets',        authMiddleware, ctrl.listSheets)
router.post('/accounts/:accId/google/sheets',       authMiddleware, ctrl.addSheet)
router.delete('/accounts/:accId/google/sheets/:id', authMiddleware, ctrl.removeSheet)

module.exports = router
