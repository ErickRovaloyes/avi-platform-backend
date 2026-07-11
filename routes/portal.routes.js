'use strict'
const router = require('express').Router()
const ctrl = require('./../controllers/portal.controller')

// Portal del cliente (público, rate-limited): consulta pedidos + reservas por teléfono.
router.get('/portal/:accId', ctrl.portal)

module.exports = router
