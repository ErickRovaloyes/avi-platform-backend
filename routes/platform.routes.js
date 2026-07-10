'use strict'
const router = require('express').Router()
const multer = require('multer')
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/platform.controller')
const coex = require('../controllers/whatsappCoexistence.controller')

// Documento opcional al crear una cuenta (genera el prompt del agente).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })
const withUpload = (mw) => (req, res, next) => mw(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite de 100 MB.' : ('No se pudo procesar el archivo: ' + (err.message || err.code)) })
  next()
})

// Public — no auth required
router.get('/platform/integrations',    ctrl.getPublicIntegrations)

// WhatsApp Coexistence (Embedded Signup con la app global)
router.get('/whatsapp/coexistence/config',    coex.getConfig)
router.post('/whatsapp/coexistence/exchange', authMiddleware, coex.exchange)

// Platform settings — /api/platform/settings (called by SuperAdminShell)
router.get('/platform/settings',        authMiddleware, ctrl.getSettings)
router.put('/platform/settings',        authMiddleware, ctrl.updateSettings)
router.post('/platform/test-email',     authMiddleware, ctrl.testEmail)

// Superadmin aliases — /api/superadmin/settings (called by AccountContext)
router.get('/superadmin/settings',                      authMiddleware, ctrl.getSettings)
router.put('/superadmin/settings',                      authMiddleware, ctrl.updateSettings)
router.get('/superadmin/super-admins',                  authMiddleware, ctrl.listSuperAdmins)
router.post('/superadmin/super-admins',                 authMiddleware, ctrl.createSuperAdmin)
router.put('/superadmin/super-admins/:saId',            authMiddleware, ctrl.updateSuperAdmin)
router.delete('/superadmin/super-admins/:saId',         authMiddleware, ctrl.deleteSuperAdmin)
router.get('/superadmin/users',                         authMiddleware, ctrl.listAllUsers)
router.get('/superadmin/module-usage',                  authMiddleware, ctrl.getModuleUsage)
router.get('/superadmin/accounts',                      authMiddleware, ctrl.listAccounts)
router.post('/superadmin/accounts',                     authMiddleware, ctrl.createAccount)
router.put('/superadmin/accounts/:accId',               authMiddleware, ctrl.updateSAAccount)
router.get('/superadmin/accounts/:accId/name-history',  authMiddleware, ctrl.getAccountNameHistory)
router.delete('/superadmin/accounts/:accId',            authMiddleware, ctrl.deleteAccount)

module.exports = router
