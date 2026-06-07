'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/tutorials.controller')

router.get('/tutorials/public',  ctrl.listPublic)
router.get('/tutorials',         authMiddleware, ctrl.list)
router.post('/tutorials',        authMiddleware, ctrl.create)
router.put('/tutorials/:id',     authMiddleware, ctrl.update)
router.delete('/tutorials/:id',  authMiddleware, ctrl.destroy)

module.exports = router
