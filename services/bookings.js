'use strict'
/**
 * Servicio de reservas — API interna reutilizable (HTTP + nodos de flujo +
 * página pública). Encapsula el acceso a `calendars` / `calendar_bookings` y la
 * validación de disponibilidad. Pensado para escalar (consultas indexadas por
 * calendario + fecha).
 */

const pool = require('../db')
const { uid, parseJ } = require('../utils')
const av = require('./availability')

const BOOKING_STATUSES = ['pending', 'confirmed', 'rescheduled', 'cancelled', 'noshow', 'completed']

function mapCalendar(r) {
  if (!r) return null
  return {
    id: r.id, accountId: r.account_id, type: r.type || 'booking',
    name: r.name, description: r.description || '', timezone: r.timezone || 'America/Lima',
    color: r.color || '#7c6fff', status: r.status || 'active',
    availability: parseJ(r.availability, {}),
    exceptions:   parseJ(r.exceptions, []),
    appointment:  parseJ(r.appointment, {}),
    formConfig:   parseJ(r.form_config, {}),
    flowId: r.flow_id || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function mapBooking(r) {
  if (!r) return null
  return {
    id: r.id, accountId: r.account_id, calendarId: r.calendar_id,
    date: r.date, time: r.time, duration: r.duration,
    clientName: r.client_name, clientPhone: r.client_phone, clientEmail: r.client_email,
    channel: r.channel || 'manual', status: r.status || 'pending',
    notes: r.notes || '', meta: parseJ(r.meta, {}), externalId: r.external_id || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

async function getCalendar(accId, calendarId) {
  const [[r]] = await pool.query('SELECT * FROM calendars WHERE id=? AND account_id=?', [calendarId, accId])
  return mapCalendar(r)
}

async function listCalendars(accId) {
  const [rows] = await pool.query('SELECT * FROM calendars WHERE account_id=? ORDER BY created_at DESC', [accId])
  return rows.map(mapCalendar)
}

// Reservas de un calendario, con filtros opcionales.
async function listBookings(accId, calendarId, { date, from, to, status, q } = {}) {
  const where = ['account_id=?', 'calendar_id=?']
  const params = [accId, calendarId]
  if (date)   { where.push('date=?'); params.push(date) }
  if (from)   { where.push('date>=?'); params.push(from) }
  if (to)     { where.push('date<=?'); params.push(to) }
  if (status) { where.push('status=?'); params.push(status) }
  if (q)      { where.push('(client_name LIKE ? OR client_phone LIKE ? OR client_email LIKE ?)'); const like = `%${q}%`; params.push(like, like, like) }
  const [rows] = await pool.query(
    `SELECT * FROM calendar_bookings WHERE ${where.join(' AND ')} ORDER BY date DESC, time DESC LIMIT 2000`,
    params
  )
  return rows.map(mapBooking)
}

async function getBooking(accId, bookingId) {
  const [[r]] = await pool.query('SELECT * FROM calendar_bookings WHERE id=? AND account_id=?', [bookingId, accId])
  return mapBooking(r)
}

// Reservas activas de un calendario en una fecha (para calcular disponibilidad).
async function bookingsForDate(accId, calendarId, dateStr) {
  const [rows] = await pool.query(
    'SELECT id, date, time, duration, status FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND date=?',
    [accId, calendarId, dateStr]
  )
  return rows.map(r => ({ id: r.id, date: r.date, time: r.time, duration: r.duration, status: r.status }))
}

async function getAvailability(accId, calendarId, dateStr, durationMin) {
  const calendar = await getCalendar(accId, calendarId)
  if (!calendar) throw new Error('Calendario no encontrado')
  const bookings = await bookingsForDate(accId, calendarId, dateStr)
  return av.computeSlots(calendar, dateStr, bookings, { durationMin })
}

// Crea una reserva. Valida el slot salvo que validate=false (reserva manual).
async function createBooking(accId, calendarId, data = {}, { validate = true } = {}) {
  const calendar = await getCalendar(accId, calendarId)
  if (!calendar) throw new Error('Calendario no encontrado')
  const date = String(data.date || '').slice(0, 10)
  const time = String(data.time || '').slice(0, 5)
  if (!date || !time) throw new Error('Fecha y hora requeridas')
  const duration = Number(data.duration) || Number(calendar.appointment?.defaultDuration) || 30

  if (validate) {
    const bookings = await bookingsForDate(accId, calendarId, date)
    if (!av.isSlotAvailable(calendar, date, time, bookings, { durationMin: duration })) {
      throw new Error('El horario seleccionado ya no está disponible')
    }
  }

  const id = 'bk_' + uid()
  const ts = Date.now()
  const status = BOOKING_STATUSES.includes(data.status) ? data.status : 'pending'
  await pool.query(
    `INSERT INTO calendar_bookings
       (id, account_id, calendar_id, date, time, duration, client_name, client_phone, client_email, channel, status, notes, meta, external_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, accId, calendarId, date, time, duration,
     data.clientName || '', data.clientPhone || '', data.clientEmail || '',
     data.channel || 'manual', status, data.notes || '',
     JSON.stringify(data.meta || {}), data.externalId || null, ts, ts]
  )
  return getBooking(accId, id)
}

async function rescheduleBooking(accId, bookingId, newDate, newTime, { validate = true } = {}) {
  const booking = await getBooking(accId, bookingId)
  if (!booking) throw new Error('Reserva no encontrada')
  const date = String(newDate || '').slice(0, 10)
  const time = String(newTime || '').slice(0, 5)
  if (!date || !time) throw new Error('Nueva fecha y hora requeridas')
  if (validate) {
    const calendar = await getCalendar(accId, booking.calendarId)
    const bookings = await bookingsForDate(accId, booking.calendarId, date)
    if (!av.isSlotAvailable(calendar, date, time, bookings, { durationMin: booking.duration, ignoreBookingId: bookingId })) {
      throw new Error('El nuevo horario no está disponible')
    }
  }
  await pool.query(
    'UPDATE calendar_bookings SET date=?, time=?, status=?, updated_at=? WHERE id=? AND account_id=?',
    [date, time, 'rescheduled', Date.now(), bookingId, accId]
  )
  return getBooking(accId, bookingId)
}

async function setBookingStatus(accId, bookingId, status) {
  if (!BOOKING_STATUSES.includes(status)) throw new Error('Estado inválido')
  await pool.query('UPDATE calendar_bookings SET status=?, updated_at=? WHERE id=? AND account_id=?',
    [status, Date.now(), bookingId, accId])
  return getBooking(accId, bookingId)
}

async function cancelBooking(accId, bookingId) {
  return setBookingStatus(accId, bookingId, 'cancelled')
}

async function updateBooking(accId, bookingId, updates = {}) {
  const map = {
    date: 'date', time: 'time', duration: 'duration',
    clientName: 'client_name', clientPhone: 'client_phone', clientEmail: 'client_email',
    channel: 'channel', status: 'status', notes: 'notes',
  }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) {
    if (updates[k] !== undefined) { sets.push(`${col}=?`); vals.push(updates[k]) }
  }
  if (updates.meta !== undefined) { sets.push('meta=?'); vals.push(JSON.stringify(updates.meta)) }
  if (!sets.length) return getBooking(accId, bookingId)
  sets.push('updated_at=?'); vals.push(Date.now())
  vals.push(bookingId, accId)
  await pool.query(`UPDATE calendar_bookings SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
  return getBooking(accId, bookingId)
}

async function deleteBooking(accId, bookingId) {
  await pool.query('DELETE FROM calendar_bookings WHERE id=? AND account_id=?', [bookingId, accId])
}

module.exports = {
  BOOKING_STATUSES, mapCalendar, mapBooking,
  getCalendar, listCalendars, listBookings, getBooking, bookingsForDate,
  getAvailability, createBooking, rescheduleBooking, cancelBooking,
  setBookingStatus, updateBooking, deleteBooking,
}
