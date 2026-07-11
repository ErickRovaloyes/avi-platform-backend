'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/crm.controller')

router.get('/accounts/:accId/crm/notes',                authMiddleware, ctrl.listNotes)
router.post('/accounts/:accId/crm/notes',               authMiddleware, ctrl.createNote)
router.delete('/accounts/:accId/crm/notes/:id',         authMiddleware, ctrl.deleteNote)

router.get('/accounts/:accId/crm/tasks',                authMiddleware, ctrl.listTasks)
router.post('/accounts/:accId/crm/tasks',               authMiddleware, ctrl.createTask)
router.put('/accounts/:accId/crm/tasks/:id',            authMiddleware, ctrl.updateTask)
router.delete('/accounts/:accId/crm/tasks/:id',         authMiddleware, ctrl.deleteTask)

router.get('/accounts/:accId/crm/activity',             authMiddleware, ctrl.listActivity)
router.get('/accounts/:accId/crm/kpis',                 authMiddleware, ctrl.kpis)
router.post('/accounts/:accId/crm/classify',            authMiddleware, ctrl.classifyConversations)
router.get('/accounts/:accId/crm/executive-summary',    authMiddleware, ctrl.previewExecutiveSummary)
router.post('/accounts/:accId/crm/executive-summary',   authMiddleware, ctrl.sendExecutiveSummary)

module.exports = router
