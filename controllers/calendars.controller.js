'use strict'
const pool = require('../db')
const { uid } = require('../utils')
const socket = require('../services/socket')
const bookings = require('../services/bookings')
const holidaysSvc = require('../services/holidays')

// ── Defaults para un calendario nuevo ────────────────────────────────────────
const DEFAULT_DAY = { enabled: true, slots: [{ start: '09:00', end: '17:00' }] }
const DEFAULT_AVAILABILITY = {
  mon: { ...DEFAULT_DAY }, tue: { ...DEFAULT_DAY }, wed: { ...DEFAULT_DAY },
  thu: { ...DEFAULT_DAY }, fri: { ...DEFAULT_DAY },
  sat: { enabled: false, slots: [] }, sun: { enabled: false, slots: [] },
}
const DEFAULT_APPOINTMENT = {
  defaultDuration: 30, types: [], buffer: 0, maxPerDay: 0,
  minAdvanceMin: 60, maxAdvanceDays: 60, allowSimultaneous: false, capacity: 1,
}

// ── Calendars CRUD ───────────────────────────────────────────────────────────
const list = async (req, res) => {
  try { res.json(await bookings.listCalendars(req.params.accId)) }
  catch (err) { console.error('[cal list]', err); res.status(500).json({ error: 'Error interno' }) }
}

const get = async (req, res) => {
  try {
    const cal = await bookings.getCalendar(req.params.accId, req.params.calId)
    if (!cal) return res.status(404).json({ error: 'Calendario no encontrado' })
    res.json(cal)
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const b = req.body || {}
  const id = b.id || ('cal_' + uid())
  const ts = Date.now()
  try {
    await pool.query(
      `INSERT INTO calendars (id, account_id, type, vertical, name, description, timezone, color, status, availability, exceptions, appointment, form_config, flow_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, accId, b.type || 'booking', b.vertical || 'appointment', b.name || 'Calendario', b.description || '',
       b.timezone || 'America/Lima', b.color || '#7c6fff', b.status || 'active',
       JSON.stringify(b.availability || DEFAULT_AVAILABILITY),
       JSON.stringify(b.exceptions || []),
       JSON.stringify(b.appointment || DEFAULT_APPOINTMENT),
       JSON.stringify(b.formConfig || {}), b.flowId || null, ts, ts]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json(await bookings.getCalendar(accId, id))
  } catch (err) { console.error('[cal create]', err); res.status(500).json({ error: 'Error interno' }) }
}

const update = async (req, res) => {
  const { accId, calId } = req.params
  const b = req.body || {}
  const map = {
    type: 'type', vertical: 'vertical', name: 'name', description: 'description', timezone: 'timezone',
    color: 'color', status: 'status', flowId: 'flow_id',
  }
  const jsonMap = { availability: 'availability', exceptions: 'exceptions', appointment: 'appointment', formConfig: 'form_config', notifications: 'notifications', integrations: 'integrations' }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  for (const [k, col] of Object.entries(jsonMap)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(JSON.stringify(b[k])) }
  if (!sets.length) return res.json(await bookings.getCalendar(accId, calId))
  sets.push('updated_at=?'); vals.push(Date.now())
  vals.push(calId, accId)
  try {
    await pool.query(`UPDATE calendars SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json(await bookings.getCalendar(accId, calId))
  } catch (err) { console.error('[cal update]', err); res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, calId } = req.params
  try {
    await pool.query('DELETE FROM calendar_bookings WHERE calendar_id=? AND account_id=?', [calId, accId])
    await pool.query('DELETE FROM calendars WHERE id=? AND account_id=?', [calId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Availability ─────────────────────────────────────────────────────────────
const availability = async (req, res) => {
  const { accId, calId } = req.params
  const { date, duration } = req.query
  if (!date) return res.status(400).json({ error: 'Falta la fecha' })
  try {
    const slots = await bookings.getAvailability(accId, calId, date, duration ? Number(duration) : undefined)
    res.json({ date, slots })
  } catch (err) { res.status(400).json({ error: err.message || 'Error' }) }
}

// Días con disponibilidad de un mes (para la cuadrícula de la página pública).
const monthAvailability = async (req, res) => {
  const { accId, calId } = req.params
  const { year, month, duration } = req.query
  if (!year || !month) return res.status(400).json({ error: 'Falta el mes' })
  try {
    const r = await bookings.getMonthAvailability(accId, calId, year, month, duration ? Number(duration) : undefined)
    res.json(r)
  } catch (err) { res.status(400).json({ error: err.message || 'Error' }) }
}

// ── Bookings ─────────────────────────────────────────────────────────────────
const listBookings = async (req, res) => {
  const { accId, calId } = req.params
  try { res.json(await bookings.listBookings(accId, calId, req.query)) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createBooking = async (req, res) => {
  const { accId, calId } = req.params
  try {
    // Reserva manual desde el panel: no forzamos validación de slot.
    const bk = await bookings.createBooking(accId, calId, req.body || {}, { validate: req.body?.validate !== false })
    socket.emit(accId, 'account:updated', { accId })
    res.json(bk)
  } catch (err) { res.status(400).json({ error: err.message || 'Error' }) }
}

const updateBooking = async (req, res) => {
  const { accId, bookingId } = req.params
  try { res.json(await bookings.updateBooking(accId, bookingId, req.body || {})) }
  catch (err) { res.status(400).json({ error: err.message || 'Error' }) }
}

const rescheduleBooking = async (req, res) => {
  const { accId, bookingId } = req.params
  const { date, time } = req.body || {}
  try { res.json(await bookings.rescheduleBooking(accId, bookingId, date, time, { validate: req.body?.validate !== false })) }
  catch (err) { res.status(400).json({ error: err.message || 'Error' }) }
}

const setStatus = async (req, res) => {
  const { accId, bookingId } = req.params
  try { res.json(await bookings.setBookingStatus(accId, bookingId, req.body?.status)) }
  catch (err) { res.status(400).json({ error: err.message || 'Error' }) }
}

const deleteBooking = async (req, res) => {
  const { accId, bookingId } = req.params
  try { await bookings.deleteBooking(accId, bookingId); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// CSV export
const exportBookings = async (req, res) => {
  const { accId, calId } = req.params
  try {
    const rows = await bookings.listBookings(accId, calId, req.query)
    const head = ['id', 'fecha', 'hora', 'duracion', 'cliente', 'telefono', 'email', 'canal', 'estado', 'notas']
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const csv = [head.join(',')]
      .concat(rows.map(b => [b.id, b.date, b.time, b.duration, b.clientName, b.clientPhone, b.clientEmail, b.channel, b.status, b.notes].map(esc).join(',')))
      .join('\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="reservas_${calId}.csv"`)
    res.send('﻿' + csv)
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Público (página de reservas) ─────────────────────────────────────────────
function publicCalendar(cal) {
  if (!cal) return null
  // Solo lo necesario para reservar (no exponemos flowId interno, etc.)
  return {
    id: cal.id, type: cal.type, name: cal.name, description: cal.description,
    timezone: cal.timezone, color: cal.color, status: cal.status,
    appointment: { defaultDuration: cal.appointment?.defaultDuration || 30, types: cal.appointment?.types || [] },
    formConfig: cal.formConfig || {},
  }
}

const getPublic = async (req, res) => {
  try {
    const cal = await bookings.getCalendar(req.params.accId, req.params.calId)
    if (!cal || cal.status === 'inactive') return res.status(404).json({ error: 'Calendario no disponible' })
    res.json(publicCalendar(cal))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const getPublicAvailability = async (req, res) => availability(req, res)
const getPublicMonthAvailability = async (req, res) => monthAvailability(req, res)

// Crea la reserva desde el formulario público y ejecuta el flujo del calendario.
const createPublicBooking = async (req, res) => {
  const { accId, calId } = req.params
  const b = req.body || {}
  try {
    const cal = await bookings.getCalendar(accId, calId)
    if (!cal || cal.status === 'inactive') return res.status(404).json({ error: 'Calendario no disponible' })

    // El consentimiento WhatsApp sólo aplica a calendarios de tipo formulario.
    // El tipo "reservas" sólo pide la selección de horario (sin datos).
    const requiresConsent = cal.type === 'form' && cal.formConfig?.whatsappConsent !== false
    if (requiresConsent && !b.whatsappConsent) {
      return res.status(400).json({ error: 'Debes autorizar el contacto por WhatsApp para reservar.' })
    }

    // Si la reserva nace de un chat (nodo "Enviar calendario"), guardamos la
    // referencia para que el flujo y las notificaciones corran en ESE chat.
    const convRef = typeof b.conversationId === 'string' && b.conversationId ? b.conversationId : null
    const meta = {
      ...(b.answers ? { answers: b.answers } : {}),
      ...(convRef ? { conversationId: convRef } : {}),
      whatsappConsent: !!b.whatsappConsent,
      whatsappConsentAt: b.whatsappConsent ? Date.now() : null,
      whatsappConsentText: 'Autorizo ser contactado por WhatsApp para recibir información relacionada con mi reserva.',
    }
    const bk = await bookings.createBooking(accId, calId, {
      ...b, channel: b.channel || 'form', status: 'confirmed', meta,
    }, { validate: true })

    socket.emit(accId, 'account:updated', { accId })

    // Ejecuta el flujo configurado (best-effort, no bloquea la reserva).
    runBookingFlow(accId, cal, bk, convRef).catch(e => console.warn('[booking flow]', e.message))

    res.json({ ok: true, booking: { id: bk.id, date: bk.date, time: bk.time, status: bk.status } })
  } catch (err) { res.status(400).json({ error: err.message || 'Error' }) }
}

// Ejecuta el flujo del calendario. Si la reserva nació de un chat (convRef),
// el flujo corre en ESA conversación; si no, crea una conversación 'form'.
async function runBookingFlow(accId, calendar, booking, convRef = null) {
  if (!calendar.flowId) return
  const store = require('../flow/store')
  const engine = require('../flow/engine')
  const account = await store.loadAccount(accId)
  const agent = account?.agents?.[0]
  if (!agent) return
  let convId = null
  let agId = agent.id
  if (convRef) {
    const [[c]] = await pool.query('SELECT id, agent_id FROM conversations WHERE id=? AND account_id=?', [convRef, accId])
    if (c) { convId = c.id; agId = c.agent_id || agent.id }
  }
  if (!convId) {
    convId = `conv_form_${Date.now()}_${booking.id}`
    const ts = Date.now()
    await pool.query(
      `INSERT INTO conversations (id, account_id, agent_id, channel_id, channel_type, guest_name, guest_id, initials, preview, unread, ai_enabled, labels, pipeline_cards, local_vars, debug_log, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [convId, accId, agId, calendar.id, 'form', booking.clientName || 'Reserva', booking.id,
       (booking.clientName || 'R').slice(0, 2).toUpperCase(), `📅 Reserva ${booking.date} ${booking.time}`,
       1, 1, '[]', '[]', JSON.stringify({ booking_id: booking.id }), '[]', ts, ts]
    )
  }
  await engine.executeFlow({
    flowId: calendar.flowId, accId, agId, convId,
    triggerContext: {
      booking_id: booking.id, reserva_id: booking.id,
      cliente_nombre: booking.clientName, cliente_telefono: booking.clientPhone, cliente_email: booking.clientEmail,
      reserva_fecha: booking.date, reserva_hora: booking.time,
      message: `Reserva ${booking.date} ${booking.time} de ${booking.clientName || ''}`,
    },
    triggeredBy: { type: 'booking' },
  })
}

// Operaciones para los nodos de flujo del NAVEGADOR (pruebas/webchat, sin JWT).
// Un único endpoint optionalAuth que mapea a los métodos del servicio de reservas.
const flowOp = async (req, res) => {
  const { accId } = req.params
  const { op, calendarId, date, time, duration, bookingId, client = {} } = req.body || {}
  try {
    if (op === 'availability') return res.json({ slots: await bookings.getAvailability(accId, calendarId, date, duration) })
    if (op === 'list')         return res.json({ bookings: await bookings.listBookings(accId, calendarId, { date }) })
    if (op === 'create') {
      const bk = await bookings.createBooking(accId, calendarId, {
        date, time, duration,
        clientName: client.name, clientPhone: client.phone, clientEmail: client.email,
        channel: client.channel || 'flow', status: 'confirmed',
      }, { validate: true })
      return res.json({ booking: bk })
    }
    if (op === 'reschedule')   return res.json({ booking: await bookings.rescheduleBooking(accId, bookingId, date, time) })
    if (op === 'cancel')       return res.json({ booking: await bookings.cancelBooking(accId, bookingId) })
    if (op === 'get')          return res.json({ booking: await bookings.getBooking(accId, bookingId) })
    res.status(400).json({ error: 'Operación inválida' })
  } catch (e) { res.status(400).json({ error: e.message || 'Error' }) }
}

// GET /api/holidays/:country/:year → festivos del país (Nager.Date, cacheado)
const holidays = async (req, res) => {
  const { country, year } = req.params
  try { res.json({ country, year, holidays: await holidaysSvc.getHolidayList(country, year) }) }
  catch { res.json({ country, year, holidays: [] }) }
}

module.exports = {
  list, get, create, update, remove, availability, monthAvailability,
  listBookings, createBooking, updateBooking, rescheduleBooking, setStatus, deleteBooking, exportBookings,
  getPublic, getPublicAvailability, getPublicMonthAvailability, createPublicBooking, flowOp, holidays,
}
