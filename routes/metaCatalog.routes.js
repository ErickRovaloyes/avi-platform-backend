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

// Índice vectorial del catálogo (mismo controller que el de la tienda, source=meta).
const pix = require('../controllers/productIndex.controller')
const metaSrc = (req, _res, next) => { req.query.source = 'meta'; next() }
router.get('/accounts/:accId/meta-catalog/vector-index',         authMiddleware, metaSrc, pix.vectorStatus)
router.put('/accounts/:accId/meta-catalog/vector-index',         authMiddleware, metaSrc, pix.vectorSaveSettings)
router.post('/accounts/:accId/meta-catalog/vector-index/sync',   authMiddleware, metaSrc, pix.vectorSyncNow)
router.post('/accounts/:accId/meta-catalog/vector-index/search', authMiddleware, metaSrc, pix.vectorTestSearch)

module.exports = router
