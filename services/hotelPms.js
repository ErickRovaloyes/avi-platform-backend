'use strict'
/**
 * Hotel PMS operativo (Fases 4b-4e) — recepción (check-in/out, walk-in, cambio de
 * habitación), housekeeping (estados + tareas), mantenimiento (OOS), folios
 * (cargos/pagos/saldo) y reportes (ocupación, ADR, RevPAR).
 *
 * Reusa el motor de reservas: las estadías son calendar_bookings vertical='hotel'
 * (date=checkin, checkout, vertical_status para el sub-estado de PMS) y las noches
 * son booking_allocations (creadas por services/hotel.bookStay).
 */

const pool = require('../db')
const { uid, parseJ } = require('../utils')
const events = require('../core/events')

const num = v => (v == null ? 0 : Number(v) || 0)
const nightsOf = (ci, co) => { const a = Date.parse(ci + 'T00:00:00Z'), b = Date.parse(co + 'T00:00:00Z'); return b > a ? Math.round((b - a) / 86400000) : 0 }

// ── Habitaciones físicas ──────────────────────────────────────────────────────
const mapRoom = r => r && ({ id: r.id, calendarId: r.calendar_id, roomTypeId: r.room_type_id, number: r.number, floor: r.floor, hkStatus: r.hk_status, status: r.status })
async function listRooms(accId, calId) {
  const [rows] = await pool.query('SELECT * FROM hotel_rooms WHERE account_id=? AND calendar_id=? ORDER BY floor ASC, number ASC', [accId, calId])
  return rows.map(mapRoom)
}
async function createRoom(accId, calId, b = {}) {
  const id = 'room_' + uid(); const ts = Date.now()
  await pool.query('INSERT INTO hotel_rooms (id, account_id, calendar_id, room_type_id, number, floor, hk_status, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.roomTypeId || null, b.number || '', Number(b.floor) || 0, 'clean', 'active', ts, ts])
  const [[r]] = await pool.query('SELECT * FROM hotel_rooms WHERE id=?', [id]); return mapRoom(r)
}
async function updateRoom(accId, id, b = {}) {
  const map = { roomTypeId: 'room_type_id', number: 'number', floor: 'floor', hkStatus: 'hk_status', status: 'status' }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
  await pool.query(`UPDATE hotel_rooms SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteRoom(accId, id) { await pool.query('DELETE FROM hotel_rooms WHERE id=? AND account_id=?', [id, accId]) }

// ── Recepción ─────────────────────────────────────────────────────────────────
const mapStay = r => r && ({
  id: r.id, clientName: r.client_name, clientPhone: r.client_phone, clientEmail: r.client_email,
  checkin: r.date, checkout: r.checkout, guests: r.party_size, status: r.status,
  verticalStatus: r.vertical_status || null, roomId: r.room_id || null, meta: parseJ(r.meta, {}),
})
async function listArrivals(accId, calId, date) {
  const [rows] = await pool.query(
    "SELECT * FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND date=? AND status NOT IN ('cancelled','noshow') AND (vertical_status IS NULL OR vertical_status NOT IN ('checked_in','checked_out')) ORDER BY client_name ASC",
    [accId, calId, date]
  )
  return rows.map(mapStay)
}
async function listDepartures(accId, calId, date) {
  const [rows] = await pool.query("SELECT * FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND checkout=? AND vertical_status='checked_in' ORDER BY client_name ASC", [accId, calId, date])
  return rows.map(mapStay)
}
async function listInHouse(accId, calId) {
  const [rows] = await pool.query("SELECT * FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND vertical_status='checked_in' ORDER BY checkout ASC", [accId, calId])
  return rows.map(mapStay)
}
async function getStay(accId, bookingId) { const [[r]] = await pool.query('SELECT * FROM calendar_bookings WHERE id=? AND account_id=?', [bookingId, accId]); return mapStay(r) }

async function checkIn(accId, bookingId, roomId) {
  const stay = await getStay(accId, bookingId)
  if (!stay) throw new Error('Reserva no encontrada')
  if (roomId) {
    const [[room]] = await pool.query('SELECT hk_status FROM hotel_rooms WHERE id=? AND account_id=?', [roomId, accId])
    if (room && room.hk_status === 'oos') throw new Error('La habitación está fuera de servicio')
  }
  await pool.query("UPDATE calendar_bookings SET vertical_status='checked_in', room_id=?, updated_at=? WHERE id=? AND account_id=?", [roomId || stay.roomId || null, Date.now(), bookingId, accId])
  await ensureFolio(accId, bookingId)
  events.emit('RoomCheckedIn', { accId, vertical: 'hotel', aggregateId: bookingId, payload: { roomId: roomId || stay.roomId } }).catch(() => {})
  return getStay(accId, bookingId)
}
async function checkOut(accId, bookingId) {
  const stay = await getStay(accId, bookingId)
  if (!stay) throw new Error('Reserva no encontrada')
  await pool.query("UPDATE calendar_bookings SET vertical_status='checked_out', status='completed', updated_at=? WHERE id=? AND account_id=?", [Date.now(), bookingId, accId])
  if (stay.roomId) {
    await pool.query("UPDATE hotel_rooms SET hk_status='dirty', updated_at=? WHERE id=? AND account_id=?", [Date.now(), stay.roomId, accId])
    await createHkTask(accId, stay.meta?.calendarId || (await calOf(accId, bookingId)), { roomId: stay.roomId, type: 'cleaning', date: new Date().toISOString().slice(0, 10) })
  }
  await pool.query("UPDATE hotel_folios SET status='closed', updated_at=? WHERE account_id=? AND booking_id=?", [Date.now(), accId, bookingId]).catch(() => {})
  events.emit('RoomCheckedOut', { accId, vertical: 'hotel', aggregateId: bookingId, payload: { roomId: stay.roomId } }).catch(() => {})
  return getStay(accId, bookingId)
}
async function calOf(accId, bookingId) { const [[r]] = await pool.query('SELECT calendar_id FROM calendar_bookings WHERE id=? AND account_id=?', [bookingId, accId]); return r?.calendar_id }
async function changeRoom(accId, bookingId, roomId) {
  await pool.query('UPDATE calendar_bookings SET room_id=?, updated_at=? WHERE id=? AND account_id=?', [roomId, Date.now(), bookingId, accId])
  events.emit('RoomChanged', { accId, vertical: 'hotel', aggregateId: bookingId, payload: { roomId } }).catch(() => {})
  return getStay(accId, bookingId)
}
// Walk-in: crea la estadía y hace check-in inmediato.
async function walkIn(accId, calId, data = {}) {
  const hotel = require('./hotel')
  const booking = await hotel.bookStay(accId, calId, { ...data, channel: 'walkin' })
  await checkIn(accId, booking.id, data.roomId)
  return booking
}

// ── Housekeeping ──────────────────────────────────────────────────────────────
const mapHk = r => r && ({ id: r.id, roomId: r.room_id, type: r.type, status: r.status, assignee: r.assignee, date: r.date, notes: r.notes || '' })
async function listHkTasks(accId, calId, { date, status } = {}) {
  const where = ['account_id=?', 'calendar_id=?']; const params = [accId, calId]
  if (date) { where.push('date=?'); params.push(date) }
  if (status) { where.push('status=?'); params.push(status) }
  const [rows] = await pool.query(`SELECT * FROM hk_tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, params)
  return rows.map(mapHk)
}
async function createHkTask(accId, calId, b = {}) {
  const id = 'hk_' + uid(); const ts = Date.now()
  await pool.query('INSERT INTO hk_tasks (id, account_id, calendar_id, room_id, type, status, assignee, date, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.roomId || null, b.type || 'cleaning', 'pending', b.assignee || '', b.date || new Date().toISOString().slice(0, 10), b.notes || '', ts, ts])
  const [[r]] = await pool.query('SELECT * FROM hk_tasks WHERE id=?', [id]); return mapHk(r)
}
async function updateHkTask(accId, id, b = {}) {
  const sets = []; const vals = []
  for (const [k, col] of Object.entries({ status: 'status', assignee: 'assignee', notes: 'notes', type: 'type' })) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
  await pool.query(`UPDATE hk_tasks SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
  // Al completar la limpieza, la habitación queda limpia.
  if (b.status === 'done') {
    const [[t]] = await pool.query('SELECT room_id FROM hk_tasks WHERE id=?', [id])
    if (t?.room_id) await pool.query("UPDATE hotel_rooms SET hk_status='clean', updated_at=? WHERE id=?", [Date.now(), t.room_id])
  }
}
async function setRoomHk(accId, roomId, hkStatus) { await pool.query('UPDATE hotel_rooms SET hk_status=?, updated_at=? WHERE id=? AND account_id=?', [hkStatus, Date.now(), roomId, accId]) }

// ── Mantenimiento ─────────────────────────────────────────────────────────────
const mapMnt = r => r && ({ id: r.id, roomId: r.room_id, issue: r.issue, severity: r.severity, status: r.status, oosFrom: r.oos_from, oosTo: r.oos_to })
async function listMaintenance(accId, calId, { status } = {}) {
  const where = ['account_id=?', 'calendar_id=?']; const params = [accId, calId]
  if (status) { where.push('status=?'); params.push(status) }
  const [rows] = await pool.query(`SELECT * FROM maintenance_tickets WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, params)
  return rows.map(mapMnt)
}
async function createMaintenance(accId, calId, b = {}) {
  const id = 'mnt_' + uid(); const ts = Date.now()
  await pool.query('INSERT INTO maintenance_tickets (id, account_id, calendar_id, room_id, issue, severity, status, oos_from, oos_to, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.roomId || null, b.issue || '', b.severity || 'low', 'open', b.oosFrom || null, b.oosTo || null, ts, ts])
  if (b.roomId && (b.oosFrom || b.severity === 'high')) await pool.query("UPDATE hotel_rooms SET hk_status='oos', updated_at=? WHERE id=? AND account_id=?", [ts, b.roomId, accId])
  const [[r]] = await pool.query('SELECT * FROM maintenance_tickets WHERE id=?', [id]); return mapMnt(r)
}
async function resolveMaintenance(accId, id) {
  await pool.query("UPDATE maintenance_tickets SET status='resolved', updated_at=? WHERE id=? AND account_id=?", [Date.now(), id, accId])
  const [[t]] = await pool.query('SELECT room_id FROM maintenance_tickets WHERE id=?', [id])
  if (t?.room_id) await pool.query("UPDATE hotel_rooms SET hk_status='dirty', updated_at=? WHERE id=? AND account_id=? AND hk_status='oos'", [Date.now(), t.room_id, accId])
}

// ── Folios (cuenta de la estadía) ────────────────────────────────────────────
async function ensureFolio(accId, bookingId) {
  const [[f]] = await pool.query('SELECT * FROM hotel_folios WHERE account_id=? AND booking_id=?', [accId, bookingId])
  if (f) return f.id
  const stay = await getStay(accId, bookingId)
  const id = 'fol_' + uid(); const ts = Date.now()
  const currency = stay?.meta?.currency || 'USD'
  await pool.query('INSERT INTO hotel_folios (id, account_id, booking_id, status, currency, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [id, accId, bookingId, 'open', currency, ts, ts])
  // Carga inicial: alojamiento (total de la estadía).
  const total = num(stay?.meta?.total)
  if (total > 0) await pool.query('INSERT INTO hotel_folio_lines (id, account_id, folio_id, kind, description, amount, tax, ts) VALUES (?,?,?,?,?,?,?,?)',
    ['fl_' + uid(), accId, id, 'room', `Alojamiento ${stay.meta?.roomType || ''} (${stay.meta?.nights || ''} noches)`, total, 0, ts])
  return id
}
async function getFolio(accId, bookingId) {
  const folioId = await ensureFolio(accId, bookingId)
  const [[f]] = await pool.query('SELECT * FROM hotel_folios WHERE id=?', [folioId])
  const [lines] = await pool.query('SELECT * FROM hotel_folio_lines WHERE folio_id=? ORDER BY ts ASC', [folioId])
  const [pays] = await pool.query('SELECT * FROM hotel_payments WHERE folio_id=? ORDER BY ts ASC', [folioId])
  const charges = lines.reduce((a, l) => a + num(l.amount) + num(l.tax), 0)
  const paid = pays.reduce((a, p) => a + num(p.amount), 0)
  return {
    id: folioId, bookingId, status: f.status, currency: f.currency,
    lines: lines.map(l => ({ id: l.id, kind: l.kind, description: l.description, amount: num(l.amount), tax: num(l.tax), ts: l.ts })),
    payments: pays.map(p => ({ id: p.id, method: p.method, amount: num(p.amount), currency: p.currency, isDeposit: !!p.is_deposit, ts: p.ts })),
    charges, paid, balance: charges - paid,
  }
}
async function addCharge(accId, bookingId, { kind = 'other', description = '', amount = 0, tax = 0 } = {}) {
  const folioId = await ensureFolio(accId, bookingId)
  await pool.query('INSERT INTO hotel_folio_lines (id, account_id, folio_id, kind, description, amount, tax, ts) VALUES (?,?,?,?,?,?,?,?)',
    ['fl_' + uid(), accId, folioId, kind, description, num(amount), num(tax), Date.now()])
  events.emit('FolioCharged', { accId, vertical: 'hotel', aggregateId: bookingId, payload: { kind, amount: num(amount) } }).catch(() => {})
  return getFolio(accId, bookingId)
}
async function addPayment(accId, bookingId, { method = 'cash', amount = 0, currency = 'USD', isDeposit = false } = {}) {
  const folioId = await ensureFolio(accId, bookingId)
  await pool.query('INSERT INTO hotel_payments (id, account_id, folio_id, method, amount, currency, is_deposit, ts) VALUES (?,?,?,?,?,?,?,?)',
    ['pay_' + uid(), accId, folioId, method, num(amount), currency, isDeposit ? 1 : 0, Date.now()])
  events.emit('PaymentReceived', { accId, vertical: 'hotel', aggregateId: bookingId, payload: { amount: num(amount), isDeposit } }).catch(() => {})
  return getFolio(accId, bookingId)
}

// ── Reportes (ocupación, ADR, RevPAR) ────────────────────────────────────────
async function reportKpis(accId, calId, { from, to } = {}) {
  const nights = nightsOf(from, to)
  if (!nights) throw new Error('Rango inválido')
  const hotel = require('./hotel')
  const types = await hotel.listRoomTypes(accId, calId)
  const totalRooms = types.reduce((a, t) => a + num(t.totalRooms), 0)
  const roomNightsAvailable = totalRooms * nights
  // Noches vendidas en el rango (asignaciones activas).
  const [[sold]] = await pool.query(
    `SELECT COUNT(*) AS c FROM booking_allocations a JOIN calendar_bookings b ON b.id=a.booking_id
      WHERE a.account_id=? AND b.calendar_id=? AND a.slot_start>=? AND a.slot_start<? AND b.status NOT IN ('cancelled','noshow')`,
    [accId, calId, `${from} 00:00:00`, `${to} 00:00:00`]
  )
  const roomNightsSold = num(sold?.c)
  // Ingresos de alojamiento prorrateados por noches dentro del rango.
  const [bookings] = await pool.query(
    "SELECT date, checkout, meta, status FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND status NOT IN ('cancelled') AND date < ? AND (checkout IS NULL OR checkout > ?)",
    [accId, calId, to, from]
  )
  let revenue = 0
  for (const b of bookings) {
    const meta = parseJ(b.meta, {})
    const bn = num(meta.nights) || nightsOf(b.date, b.checkout)
    if (!bn) continue
    const nightlyAvg = num(meta.total) / bn
    // noches de esta reserva dentro del rango
    const s = Math.max(Date.parse(b.date + 'T00:00:00Z'), Date.parse(from + 'T00:00:00Z'))
    const e = Math.min(Date.parse((b.checkout || b.date) + 'T00:00:00Z'), Date.parse(to + 'T00:00:00Z'))
    const inRange = e > s ? Math.round((e - s) / 86400000) : 0
    revenue += nightlyAvg * inRange
  }
  const [[cx]] = await pool.query("SELECT COUNT(*) AS c FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND status='cancelled' AND date>=? AND date<?", [accId, calId, from, to])
  const [[ns]] = await pool.query("SELECT COUNT(*) AS c FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND status='noshow' AND date>=? AND date<?", [accId, calId, from, to])
  const occupancy = roomNightsAvailable ? roomNightsSold / roomNightsAvailable : 0
  const adr = roomNightsSold ? revenue / roomNightsSold : 0
  const revpar = roomNightsAvailable ? revenue / roomNightsAvailable : 0
  return {
    from, to, nights, totalRooms, roomNightsAvailable, roomNightsSold,
    occupancy: Math.round(occupancy * 1000) / 10, // %
    revenue: Math.round(revenue * 100) / 100,
    adr: Math.round(adr * 100) / 100, revpar: Math.round(revpar * 100) / 100,
    cancellations: num(cx?.c), noShows: num(ns?.c),
  }
}

module.exports = {
  listRooms, createRoom, updateRoom, deleteRoom,
  listArrivals, listDepartures, listInHouse, getStay, checkIn, checkOut, changeRoom, walkIn,
  listHkTasks, createHkTask, updateHkTask, setRoomHk,
  listMaintenance, createMaintenance, resolveMaintenance,
  getFolio, addCharge, addPayment,
  reportKpis,
}
