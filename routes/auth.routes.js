'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/auth.controller')

router.post('/login',           ctrl.login)
router.post('/2fa/verify',      ctrl.verify2fa)
router.post('/2fa/resend',      ctrl.resend2fa)
// Recuperar contraseña (sin sesión, por definición). `forgot` responde igual exista o no
// la cuenta para no revelar qué correos están registrados.
router.post('/forgot',          ctrl.forgot)
router.post('/reset',           ctrl.resetPassword)
router.post('/switch',          authMiddleware, ctrl.switchAccount)
router.post('/impersonate',     authMiddleware, ctrl.impersonate)
router.post('/refresh',         authMiddleware, ctrl.refreshSession)
// La cookie es httpOnly: JavaScript no puede borrarla, así que cerrar sesión tiene que
// pedírselo al servidor. Sin autenticación a propósito: cerrar sesión con un token ya
// caducado debe funcionar igual.
router.post('/logout',          ctrl.logout)
router.post('/stop-impersonating', authMiddleware, ctrl.stopImpersonating)
router.put('/me',               authMiddleware, ctrl.updateMyProfile)
router.get('/me/notif-prefs',   authMiddleware, ctrl.getMyNotifPrefs)
router.put('/me/notif-prefs',   authMiddleware, ctrl.saveMyNotifPrefs)
router.post('/me/notif-test-email', authMiddleware, ctrl.notifTestEmail)

module.exports = router
