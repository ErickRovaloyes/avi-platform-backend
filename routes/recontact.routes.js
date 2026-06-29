'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/recontact.controller')

router.get('/accounts/:accId/recontact', authMiddleware, ctrl.getConfig)
router.put('/accounts/:accId/recontact', authMiddleware, ctrl.saveConfig)

module.exports = router
