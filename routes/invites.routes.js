'use strict'
const router = require('express').Router()
const { authMiddleware, optionalAuth } = require('../auth')
const ctrl = require('../controllers/invites.controller')

router.get('/',                         authMiddleware, ctrl.listInvites)
router.get('/:token',                               ctrl.getByToken)
router.post('/',                        authMiddleware, ctrl.createInvite)
// Optional auth: when the user is already logged in we read their email from the JWT instead
// of trusting the body, and we adapt the flow for super-admins.
router.post('/:token/accept',           optionalAuth,  ctrl.acceptInvite)
router.delete('/:token',                authMiddleware, ctrl.deleteInvite)

module.exports = router
