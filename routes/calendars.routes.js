'use strict'
const router = require('express').Router()
const { authMiddleware, optionalAuth } = require('../auth')
const ctrl = require('../controllers/calendars.controller')

// ── Gestión (autenticado) ────────────────────────────────────────────────────
router.get('/accounts/:accId/calendars',                 authMiddleware, ctrl.list)
router.post('/accounts/:accId/calendars',                authMiddleware, ctrl.create)
router.get('/accounts/:accId/calendars/:calId',          authMiddleware, ctrl.get)
router.put('/accounts/:accId/calendars/:calId',          authMiddleware, ctrl.update)
router.delete('/accounts/:accId/calendars/:calId',       authMiddleware, ctrl.remove)
router.get('/accounts/:accId/calendars/:calId/availability', authMiddleware, ctrl.availability)

// Reservas
router.get('/accounts/:accId/calendars/:calId/bookings',     authMiddleware, ctrl.listBookings)
router.post('/accounts/:accId/calendars/:calId/bookings',    authMiddleware, ctrl.createBooking)
router.get('/accounts/:accId/calendars/:calId/bookings/export', authMiddleware, ctrl.exportBookings)
router.put('/accounts/:accId/bookings/:bookingId',           authMiddleware, ctrl.updateBooking)
router.post('/accounts/:accId/bookings/:bookingId/reschedule', authMiddleware, ctrl.rescheduleBooking)
router.post('/accounts/:accId/bookings/:bookingId/status',   authMiddleware, ctrl.setStatus)
router.delete('/accounts/:accId/bookings/:bookingId',        authMiddleware, ctrl.deleteBooking)

// ── Público (página de reservas / formulario) ────────────────────────────────
router.get('/public/calendars/:accId/:calId',                optionalAuth, ctrl.getPublic)
router.get('/public/calendars/:accId/:calId/availability',   optionalAuth, ctrl.getPublicAvailability)
router.post('/public/calendars/:accId/:calId/book',          optionalAuth, ctrl.createPublicBooking)
// Operaciones de los nodos de flujo del navegador (pruebas/webchat).
router.post('/public/calendars/:accId/flow-op',              optionalAuth, ctrl.flowOp)
// Festivos por país (público — lo usa la UI de calendario y la página de reservas).
router.get('/holidays/:country/:year',                       ctrl.holidays)

module.exports = router
