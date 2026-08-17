'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/sandbox.controller')

router.get('/accounts/:accId/sandbox',    authMiddleware, ctrl.getInfo)
router.post('/accounts/:accId/sandbox',   authMiddleware, ctrl.crear)
router.delete('/accounts/:accId/sandbox', authMiddleware, ctrl.eliminar)

module.exports = router
