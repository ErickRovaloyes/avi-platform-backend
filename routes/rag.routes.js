'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/rag.controller')

router.get('/:accId/:agId',             authMiddleware, ctrl.getRag)
router.put('/:accId/:agId',             authMiddleware, ctrl.putRag)
router.delete('/:accId/:agId/:fileId',  authMiddleware, ctrl.deleteRagFile)

module.exports = router
