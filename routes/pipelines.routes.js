'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/pipelines.controller')

router.post('/accounts/:accId/pipelines',               authMiddleware, ctrl.createPipeline)
router.put('/accounts/:accId/pipelines/:pipeId',        authMiddleware, ctrl.updatePipeline)
router.delete('/accounts/:accId/pipelines/:pipeId',     authMiddleware, ctrl.deletePipeline)
router.post('/pipelines/:accId',                        authMiddleware, ctrl.createPipeline)
router.put('/pipelines/:accId/:pipeId',                 authMiddleware, ctrl.updatePipeline)
router.delete('/pipelines/:accId/:pipeId',              authMiddleware, ctrl.deletePipeline)

module.exports = router
