'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/members.controller')

// ── Members ───────────────────────────────────────────────────────────────────
// Eliminar un usuario por completo (todas sus cuentas) — solo super admin.
// Debe ir ANTES de `/members/:accId` para que no lo capture esa ruta genérica.
router.post('/members/delete-user',                 authMiddleware, ctrl.deleteUserEverywhere)
router.post('/accounts/:accId/members',             authMiddleware, ctrl.createMember)
router.put('/accounts/:accId/members/:memId',       authMiddleware, ctrl.updateMember)
router.delete('/accounts/:accId/members/:memId',    authMiddleware, ctrl.deleteMember)
router.post('/members/:accId',                      authMiddleware, ctrl.createMember)
router.put('/members/:accId/:memId',                authMiddleware, ctrl.updateMember)
router.delete('/members/:accId/:memId',             authMiddleware, ctrl.deleteMember)

// ── Roles ─────────────────────────────────────────────────────────────────────
router.post('/accounts/:accId/roles',               authMiddleware, ctrl.createRole)
router.put('/accounts/:accId/roles/:roleId',        authMiddleware, ctrl.updateRole)
router.delete('/accounts/:accId/roles/:roleId',     authMiddleware, ctrl.deleteRole)
router.post('/roles/:accId',                        authMiddleware, ctrl.createRole)
router.put('/roles/:accId/:roleId',                 authMiddleware, ctrl.updateRole)
router.delete('/roles/:accId/:roleId',              authMiddleware, ctrl.deleteRole)

// ── Labels ────────────────────────────────────────────────────────────────────
router.post('/accounts/:accId/labels',              authMiddleware, ctrl.createLabel)
router.put('/accounts/:accId/labels/:lblId',        authMiddleware, ctrl.updateLabel)
router.delete('/accounts/:accId/labels/:lblId',     authMiddleware, ctrl.deleteLabel)
router.post('/labels/:accId',                       authMiddleware, ctrl.createLabel)
router.put('/labels/:accId/:lblId',                 authMiddleware, ctrl.updateLabel)
router.delete('/labels/:accId/:lblId',              authMiddleware, ctrl.deleteLabel)

module.exports = router
