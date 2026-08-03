'use strict'
const router = require('express').Router()
const ctrl = require('../controllers/flowAssist.controller')

// Público, igual que el resto de proxies del motor de flujos (el widget del webchat no
// está autenticado). Solo resuelve a qué asesor toca y redacta el mensaje de transferencia.
router.post('/accounts/:accId/flow/transfer-resolve', ctrl.transferResolve)

module.exports = router
