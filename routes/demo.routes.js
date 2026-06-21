'use strict'
const router = require('express').Router()
const multer = require('multer')
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/demo.controller')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } })

// Público: estado del registro + descarga de la plantilla activa + alta de Demo.
router.get('/public/demo-status',     ctrl.publicStatus)
router.get('/public/demo-template',   ctrl.downloadActiveTemplate)
router.post('/public/demo-signup',    upload.single('document'), ctrl.signup)

// Superadmin: dashboard de Demos.
router.get('/admin/demo/dashboard',          authMiddleware, ctrl.getDashboard)

// Superadmin: auditoría / excepciones.
router.get('/admin/demo/registrations',      authMiddleware, ctrl.listRegistrations)
router.get('/admin/demo/overrides',          authMiddleware, ctrl.listOverrides)
router.post('/admin/demo/allow',             authMiddleware, ctrl.allow)
router.delete('/admin/demo/overrides/:id',   authMiddleware, ctrl.removeOverride)
router.post('/admin/demo/ip-restriction',    authMiddleware, ctrl.setIpRestriction)

// Superadmin: interruptor del registro Demo.
router.get('/admin/demo/registration',       authMiddleware, ctrl.getRegistration)
router.post('/admin/demo/registration',      authMiddleware, ctrl.setRegistration)

// Superadmin: plantilla de descubrimiento empresarial.
router.get('/admin/demo/templates',                 authMiddleware, ctrl.listTemplates)
router.post('/admin/demo/templates',                authMiddleware, upload.single('file'), ctrl.uploadTemplate)
router.post('/admin/demo/templates/:id/activate',   authMiddleware, ctrl.activateTemplate)
router.delete('/admin/demo/templates/:id',          authMiddleware, ctrl.deleteTemplate)
router.get('/admin/demo/templates/:id/download',    authMiddleware, ctrl.downloadTemplate)

module.exports = router
