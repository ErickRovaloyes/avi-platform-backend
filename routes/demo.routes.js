'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/demo.controller')

// Público: registro de cuenta Demo (con antifraude).
router.post('/public/demo-signup', ctrl.signup)

// Superadmin: auditoría / excepciones.
router.get('/admin/demo/registrations',      authMiddleware, ctrl.listRegistrations)
router.get('/admin/demo/overrides',          authMiddleware, ctrl.listOverrides)
router.post('/admin/demo/allow',             authMiddleware, ctrl.allow)
router.delete('/admin/demo/overrides/:id',   authMiddleware, ctrl.removeOverride)
router.post('/admin/demo/ip-restriction',    authMiddleware, ctrl.setIpRestriction)

module.exports = router
