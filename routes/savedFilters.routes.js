'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/savedFilters.controller')

router.get('/accounts/:accId/saved-filters',         authMiddleware, ctrl.list)
router.post('/accounts/:accId/saved-filters',        authMiddleware, ctrl.create)
router.delete('/accounts/:accId/saved-filters/:id',  authMiddleware, ctrl.remove)

module.exports = router
