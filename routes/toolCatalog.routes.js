'use strict'
const express = require('express')
const router = express.Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/toolCatalog.controller')

// El catálogo que ve una cuenta (solo lo publicado, marcando lo instalado).
router.get('/accounts/:accId/tool-catalog',                   authMiddleware, ctrl.listCatalog)
// Instalar / actualizar / quitar en esa cuenta.
router.post('/accounts/:accId/tool-catalog/:toolId/install',  authMiddleware, ctrl.installTool)
router.delete('/accounts/:accId/tool-catalog/:toolId',        authMiddleware, ctrl.uninstallTool)

// Gestión del catálogo (super admin). Va DESPUÉS de las rutas de cuenta para que
// `/tool-catalog` sin cuenta no capture las anteriores.
// Los handlers de codigo que hay en el repositorio, para elegirlos al crear una ficha.
router.get('/tool-handlers',                                  authMiddleware, ctrl.listHandlers)
router.get('/tool-catalog',                                   authMiddleware, ctrl.listCatalog)
router.post('/tool-catalog',                                  authMiddleware, ctrl.upsertCatalogTool)
router.put('/tool-catalog/:toolId',                           authMiddleware, ctrl.upsertCatalogTool)
router.delete('/tool-catalog/:toolId',                        authMiddleware, ctrl.deleteCatalogTool)

module.exports = router
