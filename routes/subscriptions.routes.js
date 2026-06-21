'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/subscriptions.controller')

// Tipos de cuenta
router.get('/account-types',            authMiddleware, ctrl.listTypes)
router.post('/account-types',           authMiddleware, ctrl.createType)
router.put('/account-types/:id',        authMiddleware, ctrl.updateType)
router.delete('/account-types/:id',     authMiddleware, ctrl.deleteType)

// Planes / mensualidades
router.get('/subscription-plans',        authMiddleware, ctrl.listPlans)
router.post('/subscription-plans',       authMiddleware, ctrl.createPlan)
router.put('/subscription-plans/:id',    authMiddleware, ctrl.updatePlan)
router.delete('/subscription-plans/:id', authMiddleware, ctrl.deletePlan)

// Dashboard de supervisión (superadmin)
router.get('/admin/subscriptions/overview',   authMiddleware, ctrl.getOverview)
router.get('/admin/subscriptions/commercial', authMiddleware, ctrl.getCommercial)

// Suscripción por cuenta
router.get('/accounts/:accId/subscription',         authMiddleware, ctrl.getAccountSubscription)
router.put('/accounts/:accId/subscription',         authMiddleware, ctrl.assign)
router.post('/accounts/:accId/subscription/action', authMiddleware, ctrl.action)

module.exports = router
