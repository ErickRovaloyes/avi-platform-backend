'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/flowTemplates.controller')

// Biblioteca global de plantillas de flujos.
router.get('/flow-templates',        authMiddleware, ctrl.list)     // cualquier miembro (para instalar)
router.post('/flow-templates',       authMiddleware, ctrl.create)   // solo super admin (publicar)
router.put('/flow-templates/:id',    authMiddleware, ctrl.update)   // solo super admin
router.delete('/flow-templates/:id', authMiddleware, ctrl.remove)   // solo super admin
// Instalar una plantilla en una cuenta (clona el grafo en un flujo nuevo).
router.post('/accounts/:accId/flows/from-template/:templateId', authMiddleware, ctrl.install)

module.exports = router
