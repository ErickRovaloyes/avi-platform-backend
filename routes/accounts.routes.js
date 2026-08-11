'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/accounts.controller')
const del  = require('../controllers/accountDeletion.controller')

router.get('/public/:accId',                                    ctrl.getPublicAccount)
router.get('/:accId',                                           authMiddleware, ctrl.getAccount)
router.put('/:accId',                                           authMiddleware, ctrl.updateAccount)
// Borrado de la PROPIA cuenta, en dos pasos y con código al correo registrado.
router.post('/:accId/delete/request',                           authMiddleware, del.requestDelete)
router.post('/:accId/delete/confirm',                           authMiddleware, del.confirmDelete)
router.get('/:accId/change-agent-usage',                        authMiddleware, ctrl.getChangeAgentUsage)
router.post('/:accId/change-agent-usage',                       authMiddleware, ctrl.incrementChangeAgentUsage)
router.post('/:accId/change-agent-usage/increment',             authMiddleware, ctrl.incrementChangeAgentUsage)
router.get('/:accId/effective-keys',                            authMiddleware, ctrl.getEffectiveKeys)
// Copiloto por WhatsApp: gestión de números (listar / desbloquear).
router.get('/:accId/copilot-wa/auth',                           authMiddleware, ctrl.copilotWaList)
router.post('/:accId/copilot-wa/unblock',                       authMiddleware, ctrl.copilotWaUnblock)

module.exports = router
