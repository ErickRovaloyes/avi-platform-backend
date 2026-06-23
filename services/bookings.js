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
const holidays = require('./holidays')
const { notify } = require('./calendarNotify')
const sync = require('./calendarSync')
const events = require('../core/events')
const { resolveStrategy } = require('../core/strategies')
const states = require('../core/booking/states')
const restaurant = require('./restaurant')

// Contexto de datos que las estrategias de disponibilidad reciben por inyección.
// Cada estrategia usa solo lo que necesita (time-slot: holiday/bookings/google;
// capacity: tables/shifts/allocations).
//
// Si el calendario pertenece a un grupo de ESPACIOS COMPARTIDOS, la carga de
// reservas del día incluye las de sus calendarios hermanos, de modo que una cita
// solapada en cualquiera de ellos bloquee el horario aquí (exclusión mutua).
function strategyCtx(calendar = null) {
  return {
    holidayBlocked,
    bookingsForDate: (calendar && calendar.sharedGroup)
      ? ((accId, _calId, dateStr) => sharedBookingsForDate(accId, calendar, dateStr))
      : bookingsForDate,
    googleBusyForDate: sync.busyForDate,
    getTables: restaurant.getTables, getShifts: restaurant.getShifts,
    getDateAllocations: restaurant.getDateAllocations, insertAllocations: restaurant.insertAllocations,
  }
}

// ¿La fecha cae en un festivo que el calendario decidió bloquear?
async function holidayBlocked(calendar, dateStr) {
  const ap = calendar.appointment || {}
  if (ap.holidayMode !== 'block' || !ap.holidayCountry) return false
  try { return await holidays.isHoliday(ap.holidayCountry, dateStr) } catch { return false }
}

const BOOKING_STATUSES = ['pending', 'confirmed', 'rescheduled', 'cancelled', 'noshow', 'completed']

function mapCalendar(r) {
  if (!r) return null
  return {
    id: r.id, accountId: r.account_id, type: r.type || 'booking',
    vertical: r.vertical || 'appointment',
    name: r.name, description: r.description || '', timezone: r.timezone || 'America/Lima',
    color: r.color || '#7c6fff', status: r.status || 'active',
    availability: parseJ(r.availability, {}),
    exceptions:   parseJ(r.exceptions, []),
    appointment:  parseJ(r.appointment, {}),
    formConfig:   parseJ(r.form_config, {}),
    notifications: parseJ(r.notifications, {}),
    integrations: parseJ(r.integrations, {}),
    flowId: r.flow_id || null,
    sharedGroup: r.shared_group || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function mapBooking(r) {
  if (!r) return null
  return {
    id: r.id, accountId: r.account_id, calendarId: r.calendar_id,
    date: r.date, time: r.time, duration: r.duration,
    clientName: r.client_name, clientPhone: r.client_phone, clientEmail: r.client_email,
    customerId: r.customer_id || null, partySize: r.party_size || 1,
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

// ── Espacios compartidos ────────────────────────────────────────────────────
// Calendarios "hermanos" que comparten espacios con éste: mismo grupo, mismo
// vertical, activos y distinto id. Sirve para la exclusión mutua de citas
// solapadas entre calendarios del mismo tipo de negocio.
async function siblingCalendarIds(accId, calendar) {
  const grp = String(calendar?.sharedGroup || '').trim()
  if (!grp || !calendar?.id) return []
  try {
    const [rows] = await pool.query(
      "SELECT id FROM calendars WHERE account_id=? AND shared_group=? AND id<>? AND COALESCE(vertical,'appointment')=? AND COALESCE(status,'active')<>'inactive'",
      [accId, grp, calendar.id, calendar.vertical || 'appointment']
    )
    return rows.map(r => r.id)
  } catch { return [] }
}

// Reservas del día propias + de los calendarios que comparten espacios, para que
// una cita en un calendario bloquee el horario solapado en sus hermanos.
async function sharedBookingsForDate(accId, calendar, dateStr) {
  const own = await bookingsForDate(accId, calendar.id, dateStr)
  const sibs = await siblingCalendarIds(accId, calendar)
  if (!sibs.length) return own
  const [rows] = await pool.query(
    `SELECT id, date, time, duration, status FROM calendar_bookings
       WHERE account_id=? AND date=? AND calendar_id IN (${sibs.map(() => '?').join(',')})`,
    [accId, dateStr, ...sibs]
  )
  return [...own, ...rows.map(r => ({ id: r.id, date: r.date, time: r.time, duration: r.duration, status: r.status }))]
}

// ── Clientes (paciente/huésped) como entidad de primer nivel ────────────────
// Busca por teléfono o email; si no existe, lo crea. Best-effort (no bloquea).
async function findOrCreateCustomer(accId, { name, phone, email, profile } = {}) {
  const ph = String(phone || '').replace(/[^\d]/g, '')
  const em = String(email || '').trim().toLowerCase()
  if (!ph && !em && !String(name || '').trim()) return null
  try {
    let row = null
    if (ph) { const [[r]] = await pool.query('SELECT id FROM customers WHERE account_id=? AND phone=? LIMIT 1', [accId, ph]); row = r }
    if (!row && em) { const [[r]] = await pool.query('SELECT id FROM customers WHERE account_id=? AND email=? LIMIT 1', [accId, em]); row = r }
    if (row) {
      // Completa datos faltantes sin pisar lo existente.
      await pool.query(
        "UPDATE customers SET name=COALESCE(NULLIF(name,''), NULLIF(?, '')), email=COALESCE(NULLIF(email,''), NULLIF(?, '')), phone=COALESCE(NULLIF(phone,''), NULLIF(?, '')), profile=COALESCE(?, profile), updated_at=? WHERE id=?",
        [name || '', em, ph, profile ? JSON.stringify(profile) : null, Date.now(), row.id]
      ).catch(() => {})
      return row.id
    }
    const id = 'cust_' + uid(); const ts = Date.now()
    await pool.query(
      'INSERT INTO customers (id, account_id, name, phone, email, profile, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, accId, name || '', ph, em, profile ? JSON.stringify(profile) : null, ts, ts]
    )
    return id
  } catch (e) { console.warn('[findOrCreateCustomer]', e.message); return null }
}

// Historial de un cliente: sus datos + reservas (para que la IA personalice).
async function getCustomerHistory(accId, customerId, { limit = 100 } = {}) {
  const [[c]] = await pool.query('SELECT * FROM customers WHERE id=? AND account_id=?', [customerId, accId])
  if (!c) return null
  const [rows] = await pool.query(
    'SELECT * FROM calendar_bookings WHERE account_id=? AND customer_id=? ORDER BY date DESC, time DESC LIMIT ?',
    [accId, customerId, Number(limit) || 100]
  )
  return {
    customer: { id: c.id, name: c.name, phone: c.phone, email: c.email, profile: parseJ(c.profile, {}) },
    bookings: rows.map(mapBooking),
  }
}

// Reserva la "unidad" del slot a nivel de BD (anti doble-reserva). Best-effort:
// distribuye en los asientos 0..capacity-1; el UNIQUE de booking_allocations
// impide que dos reservas tomen el mismo asiento del mismo slot.
async function allocateSlot(accId, calendarId, bookingId, date, time, duration, calendar) {
  try {
    const ap = calendar.appointment || {}
    const capacity = ap.allowSimultaneous ? Math.max(1, Number(ap.capacity) || 1) : 1
    const startDt = `${date} ${time}:00`
    const endDt = new Date(new Date(`${date}T${time}:00Z`).getTime() + (Number(duration) || 30) * 60000)
      .toISOString().slice(0, 19).replace('T', ' ')
    for (let seat = 0; seat < capacity; seat++) {
      const unitKey = `${date}T${time}#${seat}`
      try {
        await pool.query(
          'INSERT INTO booking_allocations (id, account_id, booking_id, resource_id, unit_key, slot_start, slot_end, qty) VALUES (?,?,?,?,?,?,?,?)',
          ['alloc_' + uid(), accId, bookingId, calendarId, unitKey, startDt, endDt, 1]
        )
        return true   // asiento tomado
      } catch { /* asiento ocupado → prueba el siguiente */ }
    }
    return false
  } catch { return false }
}

async function getAvailability(accId, calendarId, dateStr, durationMin, partySize) {
  const calendar = await getCalendar(accId, calendarId)
  if (!calendar) throw new Error('Calendario no encontrado')
  // El cálculo se delega a la estrategia del vertical (time-slot / capacity / …).
  const strategy = resolveStrategy(calendar)
  return strategy.getDayAvailability(calendar, dateStr, { durationMin, partySize, ctx: strategyCtx(calendar) })
}

const toDateKey = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10))

// Devuelve los días del mes (year, month 1-12) que tienen al menos un horario
// libre. Para que la cuadrícula cargue rápido NO consulta Google por día (eso se
// resuelve al elegir el día); sí considera horario semanal, excepciones,
// festivos, reservas existentes y la ventana de antelación.
async function getMonthAvailability(accId, calendarId, year, month, durationMin, partySize) {
  const calendar = await getCalendar(accId, calendarId)
  if (!calendar) throw new Error('Calendario no encontrado')
  const y = Number(year), m = Number(month)
  if (!y || !m || m < 1 || m > 12) throw new Error('Mes inválido')
  // Estrategias no time-slot definen su propia lógica de "días abiertos" del mes.
  const strategy = resolveStrategy(calendar)
  if (typeof strategy.getMonthDays === 'function') {
    return strategy.getMonthDays(calendar, { year: y, month: m, durationMin, partySize, ctx: strategyCtx(calendar) })
  }
  const mm = String(m).padStart(2, '0')
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const first = `${y}-${mm}-01`, last = `${y}-${mm}-${String(lastDay).padStart(2, '0')}`
  // Espacios compartidos: incluye las reservas de los calendarios hermanos para
  // que un día se considere ocupado también por las citas solapadas de ellos.
  const sibs = await siblingCalendarIds(accId, calendar)
  const calIds = [calendarId, ...sibs]
  const [rows] = await pool.query(
    `SELECT date, time, duration, status FROM calendar_bookings WHERE account_id=? AND calendar_id IN (${calIds.map(() => '?').join(',')}) AND date BETWEEN ? AND ?`,
    [accId, ...calIds, first, last]
  )
  const byDate = {}
  for (const r of rows) {
    const dk = toDateKey(r.date)
    ;(byDate[dk] ||= []).push({ date: dk, time: r.time, duration: r.duration, status: r.status })
  }
  const days = []
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${y}-${mm}-${String(d).padStart(2, '0')}`
    if (await holidayBlocked(calendar, ds)) continue
    const slots = strategy.slots(calendar, ds, byDate[ds] || [], { durationMin })
    if (slots.length > 0) days.push(ds)
  }
  return { year: y, month: m, days }
}

// Crea una reserva. Valida el slot salvo que validate=false (reserva manual).
async function createBooking(accId, calendarId, data = {}, { validate = true } = {}) {
  const calendar = await getCalendar(accId, calendarId)
  if (!calendar) throw new Error('Calendario no encontrado')
  const date = String(data.date || '').slice(0, 10)
  const time = String(data.time || '').slice(0, 5)
  if (!date || !time) throw new Error('Fecha y hora requeridas')
  const duration = Number(data.duration) || Number(calendar.appointment?.defaultDuration) || 30
  const strategy = resolveStrategy(calendar)
  const isCapacity = strategy.id === 'capacity'
  const partySize = Math.max(1, Number(data.partySize) || (isCapacity ? 2 : 1))

  // Concurrencia (restaurante): lock con nombre por calendario serializa la
  // validación + asignación de mesas para evitar dobles reservas en carrera.
  let lockConn = null
  if (isCapacity) {
    try { lockConn = await pool.getConnection(); await lockConn.query('SELECT GET_LOCK(?, 10) AS l', [`book_${calendarId}`]) }
    catch { if (lockConn) { try { lockConn.release() } catch {} ; lockConn = null } }
  }
  try {
    if (validate) {
      if (isCapacity) {
        const ok = await strategy.isAvailable(calendar, { date, time, partySize, ctx: strategyCtx() })
        if (!ok) throw new Error('No hay mesa disponible para ese horario y número de personas')
      } else {
        if (await holidayBlocked(calendar, date)) throw new Error('Ese día es festivo y está bloqueado para reservas')
        // Espacios compartidos: valida contra reservas propias + de calendarios hermanos.
        const bookings = await sharedBookingsForDate(accId, calendar, date)
        if (!av.isSlotAvailable(calendar, date, time, bookings, { durationMin: duration })) {
          throw new Error('El horario seleccionado ya no está disponible')
        }
      }
    }

    const id = 'bk_' + uid()
    const ts = Date.now()
    const status = BOOKING_STATUSES.includes(data.status) ? data.status : 'pending'
    // Cliente como entidad (paciente/huésped) + perfil del vertical si viene.
    const customerId = await findOrCreateCustomer(accId, {
      name: data.clientName, phone: data.clientPhone, email: data.clientEmail, profile: data.customerProfile,
    })
    await pool.query(
      `INSERT INTO calendar_bookings
         (id, account_id, calendar_id, date, time, duration, party_size, client_name, client_phone, client_email, customer_id, channel, status, notes, meta, external_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, accId, calendarId, date, time, duration, partySize,
       data.clientName || '', data.clientPhone || '', data.clientEmail || '', customerId,
       data.channel || 'manual', status, data.notes || '',
       JSON.stringify(data.meta || {}), data.externalId || null, ts, ts]
    )
    // Asignación según la estrategia del vertical.
    if (isCapacity) {
      // Restaurante: asigna mesa(s). Si no hay (y se valida), revierte la reserva.
      const plan = await strategy.allocate(calendar, id, { date, time, partySize, ctx: strategyCtx() }).catch(() => null)
      if (!plan && validate) {
        await pool.query('DELETE FROM calendar_bookings WHERE id=?', [id]).catch(() => {})
        throw new Error('No hay mesa disponible para ese horario y número de personas')
      }
      if (plan?.windowMin) await pool.query('UPDATE calendar_bookings SET duration=? WHERE id=?', [plan.windowMin, id]).catch(() => {})
    } else {
      // Time-slot: reserva la unidad del slot (anti doble-reserva). Best-effort.
      allocateSlot(accId, calendarId, id, date, time, duration, calendar).catch(() => {})
    }
    const bk = await getBooking(accId, id)
    // notify (confirmación) + Google sync ahora son HANDLERS del outbox (ver registro al final).
    emit(calendar, 'BookingCreated', bk)
    return bk
  } finally {
    if (lockConn) { try { await lockConn.query('SELECT RELEASE_LOCK(?)', [`book_${calendarId}`]) } catch {} ; try { lockConn.release() } catch {} }
  }
}

// Emite un evento de dominio para una reserva (best-effort). El `vertical` sale
// del calendario; no altera el comportamiento actual (notify/sync siguen inline).
function emit(calendar, type, bk) {
  if (!bk) return
  events.emit(type, {
    accId: bk.accountId, vertical: calendar?.vertical || 'appointment', aggregateId: bk.id,
    payload: { calendarId: bk.calendarId, date: bk.date, time: bk.time, duration: bk.duration, status: bk.status, channel: bk.channel },
  }).catch(() => {})
}

async function rescheduleBooking(accId, bookingId, newDate, newTime, { validate = true } = {}) {
  const booking = await getBooking(accId, bookingId)
  if (!booking) throw new Error('Reserva no encontrada')
  if (!states.canTransition(booking.status, 'rescheduled')) {
    throw new Error(`No se puede reagendar una reserva en estado "${booking.status}"`)
  }
  const date = String(newDate || '').slice(0, 10)
  const time = String(newTime || '').slice(0, 5)
  if (!date || !time) throw new Error('Nueva fecha y hora requeridas')
  const calendar = await getCalendar(accId, booking.calendarId)
  const strategy = resolveStrategy(calendar || {})

  if (strategy.id === 'capacity') {
    // Restaurante: libera la mesa actual, revalida y reasigna en el nuevo horario.
    await pool.query('DELETE FROM booking_allocations WHERE booking_id=? AND account_id=?', [bookingId, accId]).catch(() => {})
    if (validate && !(await strategy.isAvailable(calendar, { date, time, partySize: booking.partySize, ctx: strategyCtx() }))) {
      // restaura la asignación anterior y aborta
      await strategy.allocate(calendar, bookingId, { date: booking.date, time: booking.time, partySize: booking.partySize, ctx: strategyCtx() }).catch(() => {})
      throw new Error('No hay mesa disponible para el nuevo horario')
    }
    await pool.query('UPDATE calendar_bookings SET date=?, time=?, status=?, updated_at=? WHERE id=? AND account_id=?', [date, time, 'rescheduled', Date.now(), bookingId, accId])
    await strategy.allocate(calendar, bookingId, { date, time, partySize: booking.partySize, ctx: strategyCtx() }).catch(() => {})
  } else {
    if (validate) {
      // Espacios compartidos: valida contra reservas propias + de calendarios hermanos.
      const bookings = await sharedBookingsForDate(accId, calendar, date)
      if (!av.isSlotAvailable(calendar, date, time, bookings, { durationMin: booking.duration, ignoreBookingId: bookingId })) {
        throw new Error('El nuevo horario no está disponible')
      }
    }
    await pool.query('UPDATE calendar_bookings SET date=?, time=?, status=?, updated_at=? WHERE id=? AND account_id=?', [date, time, 'rescheduled', Date.now(), bookingId, accId])
    await pool.query('DELETE FROM booking_allocations WHERE booking_id=? AND account_id=?', [bookingId, accId]).catch(() => {})
    if (calendar) allocateSlot(accId, booking.calendarId, bookingId, date, time, booking.duration, calendar).catch(() => {})
  }
  const bk = await getBooking(accId, bookingId)
  // notify (reagendamiento) + Google sync vía outbox (handler BookingRescheduled).
  emit(calendar, 'BookingRescheduled', bk)
  return bk
}

async function setBookingStatus(accId, bookingId, status) {
  if (!BOOKING_STATUSES.includes(status)) throw new Error('Estado inválido')
  await pool.query('UPDATE calendar_bookings SET status=?, updated_at=? WHERE id=? AND account_id=?',
    [status, Date.now(), bookingId, accId])
  const bk = await getBooking(accId, bookingId)
  // Evento de cambio de estado. 'cancelled' lo emite cancelBooking con su evento
  // específico (BookingCancelled), por eso aquí se omite para no duplicar.
  if (bk && status !== 'cancelled') {
    const map = { confirmed: 'BookingConfirmed', noshow: 'BookingNoShow', completed: 'BookingCompleted' }
    const calendar = await getCalendar(accId, bk.calendarId)
    emit(calendar, map[status] || 'BookingStatusChanged', bk)
  }
  return bk
}

async function cancelBooking(accId, bookingId) {
  const bk = await setBookingStatus(accId, bookingId, 'cancelled')
  if (bk) {
    const calendar = await getCalendar(accId, bk.calendarId)
    // Libera la unidad asignada para que el slot vuelva a estar disponible.
    await pool.query('DELETE FROM booking_allocations WHERE booking_id=? AND account_id=?', [bookingId, accId]).catch(() => {})
    // notify (cancelación) + Google sync (delete) vía outbox (handler BookingCancelled).
    emit(calendar, 'BookingCancelled', bk)
  }
  return bk
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
  await pool.query('DELETE FROM booking_allocations WHERE booking_id=? AND account_id=?', [bookingId, accId]).catch(() => {})
  await pool.query('DELETE FROM calendar_bookings WHERE id=? AND account_id=?', [bookingId, accId])
}

// ── Side-effects vía outbox (Fase 1) ────────────────────────────────────────
// notify de reserva + sync a Google Calendar dejan de ser inline y pasan a ser
// handlers de eventos de dominio. Se mantienen best-effort (no lanzan) para
// replicar exactamente el comportamiento anterior (sin doble notificación) y se
// procesan de inmediato (kick) tras emitir. Punto de extensión para webhooks,
// reportes y read-models en fases siguientes.
let _handlersRegistered = false
function registerOutboxHandlers() {
  if (_handlersRegistered) return
  _handlersRegistered = true

  events.on('BookingCreated', async (ev) => {
    try {
      const calendar = await getCalendar(ev.accId, ev.payload.calendarId)
      const bk = await getBooking(ev.accId, ev.aggregateId)
      if (!calendar || !bk) return
      notify(ev.accId, calendar, bk, 'confirmation').catch(() => {})
      sync.pushBooking(ev.accId, calendar, bk, 'create').then(eventId => {
        if (eventId) pool.query('UPDATE calendar_bookings SET external_id=? WHERE id=?', [eventId, bk.id]).catch(() => {})
      }).catch(() => {})
    } catch (e) { console.warn('[handler BookingCreated]', e.message) }
  })

  events.on('BookingRescheduled', async (ev) => {
    try {
      const calendar = await getCalendar(ev.accId, ev.payload.calendarId)
      const bk = await getBooking(ev.accId, ev.aggregateId)
      if (!calendar || !bk) return
      notify(ev.accId, calendar, bk, 'reschedule').catch(() => {})
      sync.pushBooking(ev.accId, calendar, bk, 'update').catch(() => {})
    } catch (e) { console.warn('[handler BookingRescheduled]', e.message) }
  })

  events.on('BookingCancelled', async (ev) => {
    try {
      const calendar = await getCalendar(ev.accId, ev.payload.calendarId)
      const bk = await getBooking(ev.accId, ev.aggregateId)
      if (!calendar || !bk) return
      notify(ev.accId, calendar, bk, 'cancellation').catch(() => {})
      sync.pushBooking(ev.accId, calendar, bk, 'delete').catch(() => {})
    } catch (e) { console.warn('[handler BookingCancelled]', e.message) }
  })
}
registerOutboxHandlers()

module.exports = {
  BOOKING_STATUSES, mapCalendar, mapBooking,
  getCalendar, listCalendars, listBookings, getBooking, bookingsForDate,
  getAvailability, getMonthAvailability, createBooking, rescheduleBooking, cancelBooking,
  setBookingStatus, updateBooking, deleteBooking,
  findOrCreateCustomer, getCustomerHistory, allocateSlot,
}
