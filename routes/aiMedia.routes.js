'use strict'
const router = require('express').Router()
const { optionalAuth } = require('../auth')
const ctrl = require('../controllers/aiMedia.controller')

// optionalAuth: el webchat público (sin JWT) también ejecuta flujos con estos nodos.
router.post('/accounts/:accId/ai/transcribe',       optionalAuth, ctrl.transcribe)
router.post('/accounts/:accId/ai/transcribe-blob',  optionalAuth, ctrl.transcribeBlob)
router.post('/accounts/:accId/ai/analyze-media',    optionalAuth, ctrl.analyzeMedia)

module.exports = router
