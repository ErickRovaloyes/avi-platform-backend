'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/rag.controller')

// Recuperación de contexto SERVER-SIDE (pública: la usa el webchat sin sesión).
router.post('/context/:accId/:agId',    ctrl.getContext)

router.get('/:accId/:agId',             authMiddleware, ctrl.getRag)
router.put('/:accId/:agId',             authMiddleware, ctrl.putRag)
router.delete('/:accId/:agId/:fileId',  authMiddleware, ctrl.deleteRagFile)

module.exports = router
