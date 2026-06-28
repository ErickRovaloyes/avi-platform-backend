'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/metaCatalog.controller')

router.get('/accounts/:accId/meta-catalog',          authMiddleware, ctrl.get)
router.get('/accounts/:accId/meta-catalog/discover', authMiddleware, ctrl.discover)
router.get('/accounts/:accId/meta-catalog/products', authMiddleware, ctrl.products)
router.post('/accounts/:accId/meta-catalog',         authMiddleware, ctrl.connect)
router.delete('/accounts/:accId/meta-catalog',       authMiddleware, ctrl.disconnect)

module.exports = router
