'use strict'
const router = require('express').Router()
const { authMiddleware, optionalAuth } = require('../auth')
const ctrl = require('../controllers/metaCatalog.controller')

// Proxy público para el motor del navegador/webchat (sin sesión). Devuelve solo
// productos (el token del catálogo permanece en el servidor).
router.post('/meta-catalog/:accId/search',           optionalAuth, ctrl.publicSearch)

router.get('/accounts/:accId/meta-catalog',          authMiddleware, ctrl.get)
router.get('/accounts/:accId/meta-catalog/discover', authMiddleware, ctrl.discover)
router.get('/accounts/:accId/meta-catalog/products', authMiddleware, ctrl.products)
router.post('/accounts/:accId/meta-catalog',         authMiddleware, ctrl.connect)
router.delete('/accounts/:accId/meta-catalog',       authMiddleware, ctrl.disconnect)

module.exports = router
