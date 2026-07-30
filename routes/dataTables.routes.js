'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/dataTables.controller')

// CRUD del cliente (autenticado)
router.get('/accounts/:accId/data-tables',                    authMiddleware, ctrl.listTables)
router.post('/accounts/:accId/data-tables',                   authMiddleware, ctrl.createTable)
router.put('/accounts/:accId/data-tables/:id',                authMiddleware, ctrl.updateTable)
router.delete('/accounts/:accId/data-tables/:id',             authMiddleware, ctrl.deleteTable)
router.get('/accounts/:accId/data-tables/:id/rows',           authMiddleware, ctrl.listRows)
router.post('/accounts/:accId/data-tables/:id/rows',          authMiddleware, ctrl.createRow)
router.put('/accounts/:accId/data-tables/:id/rows/:rowId',    authMiddleware, ctrl.updateRow)
router.delete('/accounts/:accId/data-tables/:id/rows/:rowId', authMiddleware, ctrl.deleteRow)

// Proxy de la herramienta IA (público, igual que /scheduling/:accId/tool)
router.post('/accounts/:accId/data-tables/tool',              ctrl.tool)

module.exports = router
