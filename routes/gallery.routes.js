'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/gallery.controller')

router.get('/accounts/:accId/gallery',            authMiddleware, ctrl.list)
router.post('/accounts/:accId/gallery',           authMiddleware, ctrl.create)
router.delete('/accounts/:accId/gallery/:id',     authMiddleware, ctrl.remove)

module.exports = router
