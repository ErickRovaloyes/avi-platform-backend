'use strict'
const router = require('express').Router()
const { authMiddleware, optionalAuth } = require('../auth')
const ctrl = require('../controllers/calendars.controller')
const rest = require('../controllers/restaurant.controller')

// ── Gestión (autenticado) ────────────────────────────────────────────────────
router.get('/accounts/:accId/calendars',                 authMiddleware, ctrl.list)
router.post('/accounts/:accId/calendars',                authMiddleware, ctrl.create)
router.get('/accounts/:accId/calendars/:calId',          authMiddleware, ctrl.get)
router.put('/accounts/:accId/calendars/:calId',          authMiddleware, ctrl.update)
router.delete('/accounts/:accId/calendars/:calId',       authMiddleware, ctrl.remove)
router.get('/accounts/:accId/calendars/:calId/availability', authMiddleware, ctrl.availability)
router.get('/accounts/:accId/calendars/:calId/month-availability', authMiddleware, ctrl.monthAvailability)

// Reservas
router.get('/accounts/:accId/calendars/:calId/bookings',     authMiddleware, ctrl.listBookings)
router.post('/accounts/:accId/calendars/:calId/bookings',    authMiddleware, ctrl.createBooking)
router.get('/accounts/:accId/calendars/:calId/bookings/export', authMiddleware, ctrl.exportBookings)
router.put('/accounts/:accId/bookings/:bookingId',           authMiddleware, ctrl.updateBooking)
router.post('/accounts/:accId/bookings/:bookingId/reschedule', authMiddleware, ctrl.rescheduleBooking)
router.post('/accounts/:accId/bookings/:bookingId/status',   authMiddleware, ctrl.setStatus)
router.delete('/accounts/:accId/bookings/:bookingId',        authMiddleware, ctrl.deleteBooking)
// Cliente / paciente / huésped — historial (datos + reservas)
router.get('/accounts/:accId/customers/:customerId/history', authMiddleware, ctrl.customerHistory)

// ── Restaurante (Fase 2): mesas, turnos, waitlist ────────────────────────────
router.get('/accounts/:accId/calendars/:calId/tables',     authMiddleware, rest.listTables)
router.post('/accounts/:accId/calendars/:calId/tables',    authMiddleware, rest.createTable)
router.put('/accounts/:accId/tables/:tableId',             authMiddleware, rest.updateTable)
router.delete('/accounts/:accId/tables/:tableId',          authMiddleware, rest.deleteTable)
router.get('/accounts/:accId/calendars/:calId/shifts',     authMiddleware, rest.listShifts)
router.post('/accounts/:accId/calendars/:calId/shifts',    authMiddleware, rest.createShift)
router.put('/accounts/:accId/shifts/:shiftId',             authMiddleware, rest.updateShift)
router.delete('/accounts/:accId/shifts/:shiftId',          authMiddleware, rest.deleteShift)
router.get('/accounts/:accId/calendars/:calId/waitlist',   authMiddleware, rest.listWaitlist)
router.post('/accounts/:accId/calendars/:calId/waitlist',  authMiddleware, rest.addWaitlist)
router.put('/accounts/:accId/waitlist/:wid',               authMiddleware, rest.updateWaitlist)

// ── Público (página de reservas / formulario) ────────────────────────────────
router.get('/public/calendars/:accId/:calId',                optionalAuth, ctrl.getPublic)
router.get('/public/calendars/:accId/:calId/availability',   optionalAuth, ctrl.getPublicAvailability)
router.get('/public/calendars/:accId/:calId/month-availability', optionalAuth, ctrl.getPublicMonthAvailability)
router.post('/public/calendars/:accId/:calId/book',          optionalAuth, ctrl.createPublicBooking)
// Operaciones de los nodos de flujo del navegador (pruebas/webchat).
router.post('/public/calendars/:accId/flow-op',              optionalAuth, ctrl.flowOp)
// Festivos por país (público — lo usa la UI de calendario y la página de reservas).
router.get('/holidays/:country/:year',                       ctrl.holidays)

module.exports = router
