'use strict'
const router = require('express').Router()
const multer = require('multer')
const { authMiddleware, soloSuperadmin } = require('../auth')
const ctrl = require('../controllers/demo.controller')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })

// Envuelve un middleware de multer para devolver errores claros en JSON
// (p. ej. archivo demasiado grande) en vez de un 500 genérico.
const withUpload = (mw) => (req, res, next) => mw(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite de 100 MB.' : ('No se pudo procesar el archivo: ' + (err.message || err.code)) })
  next()
})

// Público: estado del registro + descarga de la plantilla activa + alta de Demo.
router.get('/public/demo-status',     ctrl.publicStatus)
router.get('/public/demo-template',   ctrl.downloadActiveTemplate)
router.post('/public/demo-signup/request-code', ctrl.requestSignupCode)
router.post('/public/demo-signup',    withUpload(upload.single('document')), ctrl.signup)

// Superadmin: dashboard de Demos.
router.get('/admin/demo/dashboard',          authMiddleware, soloSuperadmin, ctrl.getDashboard)

// Superadmin: auditoría / excepciones.
router.get('/admin/demo/registrations',      authMiddleware, soloSuperadmin, ctrl.listRegistrations)
router.get('/admin/demo/overrides',          authMiddleware, soloSuperadmin, ctrl.listOverrides)
router.post('/admin/demo/allow',             authMiddleware, soloSuperadmin, ctrl.allow)
router.delete('/admin/demo/overrides/:id',   authMiddleware, soloSuperadmin, ctrl.removeOverride)
router.post('/admin/demo/ip-restriction',    authMiddleware, soloSuperadmin, ctrl.setIpRestriction)

// Superadmin: interruptor del registro Demo.
router.get('/admin/demo/registration',       authMiddleware, soloSuperadmin, ctrl.getRegistration)
router.post('/admin/demo/registration',      authMiddleware, soloSuperadmin, ctrl.setRegistration)

// Superadmin: plantilla de descubrimiento empresarial.
router.get('/admin/demo/templates',                 authMiddleware, soloSuperadmin, ctrl.listTemplates)
router.post('/admin/demo/templates',                authMiddleware, soloSuperadmin, withUpload(upload.single('file')), ctrl.uploadTemplate)
router.post('/admin/demo/templates/:id/activate',   authMiddleware, soloSuperadmin, ctrl.activateTemplate)
router.delete('/admin/demo/templates/:id',          authMiddleware, soloSuperadmin, ctrl.deleteTemplate)
router.get('/admin/demo/templates/:id/download',    authMiddleware, soloSuperadmin, ctrl.downloadTemplate)

module.exports = router
