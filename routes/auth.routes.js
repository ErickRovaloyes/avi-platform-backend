'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/auth.controller')

router.post('/login',           ctrl.login)
router.post('/switch',          authMiddleware, ctrl.switchAccount)
router.post('/impersonate',     authMiddleware, ctrl.impersonate)
router.post('/refresh',         authMiddleware, ctrl.refreshSession)
router.put('/me',               authMiddleware, ctrl.updateMyProfile)

module.exports = router
