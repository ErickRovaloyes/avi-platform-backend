'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/contacts.controller')

router.get('/accounts/:accId/contacts',                    authMiddleware, ctrl.list)
router.get('/accounts/:accId/contacts/export',             authMiddleware, ctrl.exportCsv)
router.post('/accounts/:accId/contacts/import',            authMiddleware, ctrl.importContacts)
router.post('/accounts/:accId/contacts',                   authMiddleware, ctrl.create)
router.get('/accounts/:accId/contacts/:id/conversations',  authMiddleware, ctrl.listConversations)
router.get('/accounts/:accId/contacts/:id/360',            authMiddleware, ctrl.profile360)
router.get('/accounts/:accId/contacts/:id',                authMiddleware, ctrl.getOne)
router.put('/accounts/:accId/contacts/:id',                authMiddleware, ctrl.update)
router.delete('/accounts/:accId/contacts/:id',             authMiddleware, ctrl.remove)

module.exports = router
