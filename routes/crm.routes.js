'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/crm.controller')
const seg = require('../controllers/segments.controller')
const rules = require('../controllers/crmRules.controller')

router.get('/accounts/:accId/crm/notes',                authMiddleware, ctrl.listNotes)
router.post('/accounts/:accId/crm/notes',               authMiddleware, ctrl.createNote)
router.delete('/accounts/:accId/crm/notes/:id',         authMiddleware, ctrl.deleteNote)

router.get('/accounts/:accId/crm/tasks',                authMiddleware, ctrl.listTasks)
router.post('/accounts/:accId/crm/tasks',               authMiddleware, ctrl.createTask)
router.put('/accounts/:accId/crm/tasks/:id',            authMiddleware, ctrl.updateTask)
router.delete('/accounts/:accId/crm/tasks/:id',         authMiddleware, ctrl.deleteTask)

router.get('/accounts/:accId/crm/activity',             authMiddleware, ctrl.listActivity)
router.get('/accounts/:accId/crm/kpis',                 authMiddleware, ctrl.kpis)
router.get('/accounts/:accId/crm/pipeline-velocity',    authMiddleware, ctrl.pipelineVelocity)
router.get('/accounts/:accId/crm/retention',            authMiddleware, ctrl.retention)
router.post('/accounts/:accId/crm/copilot',             authMiddleware, ctrl.copilotAsk)
router.post('/accounts/:accId/crm/detect-opportunities', authMiddleware, ctrl.detectOpportunities)
router.get('/accounts/:accId/crm/lead-scores',          authMiddleware, ctrl.leadScores)

// Segmentos dinámicos de contactos
router.get('/accounts/:accId/crm/segments',             authMiddleware, seg.list)
router.post('/accounts/:accId/crm/segments',            authMiddleware, seg.create)
router.post('/accounts/:accId/crm/segments/preview',    authMiddleware, seg.preview)
router.put('/accounts/:accId/crm/segments/:id',         authMiddleware, seg.update)
router.delete('/accounts/:accId/crm/segments/:id',      authMiddleware, seg.remove)

// Reglas / playbooks no-code
router.get('/accounts/:accId/crm/rules',                authMiddleware, rules.list)
router.post('/accounts/:accId/crm/rules',               authMiddleware, rules.create)
router.put('/accounts/:accId/crm/rules/:id',            authMiddleware, rules.update)
router.delete('/accounts/:accId/crm/rules/:id',         authMiddleware, rules.remove)
router.post('/accounts/:accId/crm/rules/:id/run',       authMiddleware, rules.run)
router.post('/accounts/:accId/crm/classify',            authMiddleware, ctrl.classifyConversations)
router.get('/accounts/:accId/crm/executive-summary',    authMiddleware, ctrl.previewExecutiveSummary)
router.post('/accounts/:accId/crm/executive-summary',   authMiddleware, ctrl.sendExecutiveSummary)

module.exports = router
