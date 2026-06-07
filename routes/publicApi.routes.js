'use strict'
const router = require('express').Router()
const { apiKeyAuth } = require('../auth')
const ctrl = require('../controllers/publicApi.controller')

// Each endpoint declares the minimum scope required so an API key with limited
// permissions can only do what it's allowed to.
router.get('/v1/me',                                apiKeyAuth(),                              ctrl.me)

router.get('/v1/conversations',                     apiKeyAuth('conversations:read'),          ctrl.listConversations)
router.put('/v1/conversations/:id/assign',          apiKeyAuth('conversations:write'),         ctrl.assignConversation)

router.post('/v1/messages',                         apiKeyAuth('messages:send'),               ctrl.sendMessage)
router.post('/v1/contacts',                         apiKeyAuth('contacts:write'),              ctrl.upsertContact)

router.post('/v1/crm/tasks',                        apiKeyAuth('crm:tasks:write'),             ctrl.createTask)
router.post('/v1/crm/notes',                        apiKeyAuth('crm:notes:write'),             ctrl.createNote)

module.exports = router
