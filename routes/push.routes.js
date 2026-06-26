'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/push.controller')

router.post('/push/register',   authMiddleware, ctrl.register)
router.post('/push/unregister', authMiddleware, ctrl.unregister)
router.post('/push/test',       authMiddleware, ctrl.test)

module.exports = router
