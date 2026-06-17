'use strict'
/**
 * Servicio de Hotel (Fase 4a) — tipos de habitación, tarifas por noche,
 * disponibilidad por rango de fechas (room-nights) y reserva de estadías.
 *
 * La unidad reservable es la NOCHE de un TIPO de habitación. La disponibilidad de
 * una estadía [checkin, checkout) requiere que TODAS sus noches tengan cupo
 * (total_rooms + overbook − vendidas). Las asignaciones se guardan en
 * booking_allocations (resource_id = roomTypeId, unit_key = `noche#bookingId`,
 * slot_start = noche) para poder contar ocupación por noche; el contador de cupo
 * se calcula dinámicamente desde las reservas activas (sin tabla de inventario).
 */

const pool = require('../db')
const { uid, parseJ } = require('../utils')
const events = require('../core/events')

// ── Helpers de fechas (PUROS) ───────────────────────────────────────────────
// Noches de una estadía: checkin (incl) .. checkout (excl) → ['YYYY-MM-DD', ...]
function nightsBetween(checkin, checkout) {
  const a = Date.parse(checkin + 'T00:00:00Z'), b = Date.parse(checkout + 'T00:00:00Z')
  if (!(a >= 0) || !(b >= 0) || b <= a) return []
  const out = []
  for (let t = a; t < b; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
// Cotiza una lista de noches: precio override por fecha, si no, base. PURO.
function quoteNights(nights, basePrice, overridesByDate = {}) {
  const perNight = nights.map(d => ({ date: d, price: Number(overridesByDate[d] != null ? overridesByDate[d] : basePrice) || 0 }))
  const total = perNight.reduce((a, p) => a + p.price, 0)
  return { perNight, total }
}

// ── Tipos de habitación ──────────────────────────────────────────────────────
const mapRT = r => r && ({
  id: r.id, calendarId: r.calendar_id, name: r.name,
  baseCapacity: r.base_capacity, maxCapacity: r.max_capacity,
  totalRooms: r.total_rooms, overbookLimit: r.overbook_limit,
  basePrice: r.base_price != null ? Number(r.base_price) : 0, currency: r.currency || 'USD',
  amenities: parseJ(r.amenities, []), status: r.status || 'active',
})
async function listRoomTypes(accId, calId, { all = false } = {}) {
  const [rows] = await pool.query(`SELECT * FROM hotel_room_types WHERE account_id=? AND calendar_id=? ${all ? '' : "AND status<>'inactive'"} ORDER BY base_price ASC, name ASC`, [accId, calId])
  return rows.map(mapRT)
}
async function getRoomType(accId, id) { const [[r]] = await pool.query('SELECT * FROM hotel_room_types WHERE id=? AND account_id=?', [id, accId]); return mapRT(r) }
async function createRoomType(accId, calId, b = {}) {
  const id = 'rt_' + uid(); const ts = Date.now()
  await pool.query('INSERT INTO hotel_room_types (id, account_id, calendar_id, name, base_capacity, max_capacity, total_rooms, overbook_limit, base_price, currency, amenities, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.name || 'Habitación', Number(b.baseCapacity) || 2, Number(b.maxCapacity) || 2, Number(b.totalRooms) || 1, Number(b.overbookLimit) || 0, Number(b.basePrice) || 0, b.currency || 'USD', JSON.stringify(b.amenities || []), 'active', ts, ts])
  return getRoomType(accId, id)
}
async function updateRoomType(accId, id, b = {}) {
  const map = { name: 'name', baseCapacity: 'base_capacity', maxCapacity: 'max_capacity', totalRooms: 'total_rooms', overbookLimit: 'overbook_limit', basePrice: 'base_price', currency: 'currency', status: 'status' }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  if (b.amenities !== undefined) { sets.push('amenities=?'); vals.push(JSON.stringify(b.amenities)) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
  await pool.query(`UPDATE hotel_room_types SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteRoomType(accId, id) { await pool.query('DELETE FROM hotel_room_types WHERE id=? AND account_id=?', [id, accId]) }

// ── Tarifas (overrides por noche) ─────────────────────────────────────────────
async function overridesFor(accId, roomTypeId, from, to) {
  const [rows] = await pool.query('SELECT date, price FROM hotel_rate_overrides WHERE account_id=? AND room_type_id=? AND date>=? AND date<?', [accId, roomTypeId, from, to])
  const m = {}; for (const r of rows) m[r.date] = Number(r.price); return m
}
async function listRates(accId, roomTypeId, { from, to } = {}) {
  const where = ['account_id=?', 'room_type_id=?']; const params = [accId, roomTypeId]
  if (from) { where.push('date>=?'); params.push(from) }
  if (to) { where.push('date<=?'); params.push(to) }
  const [rows] = await pool.query(`SELECT date, price FROM hotel_rate_overrides WHERE ${where.join(' AND ')} ORDER BY date ASC`, params)
  return rows.map(r => ({ date: r.date, price: Number(r.price) }))
}
// Fija el precio de un rango de fechas [from, to] (inclusive) para un tipo.
async function setRateRange(accId, roomTypeId, from, to, price) {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z')
  if (!(a >= 0) || !(b >= 0) || b < a) throw new Error('Rango de fechas inválido')
  for (let t = a; t <= b; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10)
    await pool.query('INSERT INTO hotel_rate_overrides (id, account_id, room_type_id, date, price) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE price=VALUES(price)',
      ['rate_' + uid(), accId, roomTypeId, d, Number(price) || 0])
  }
  return { ok: true }
}
async function clearRate(accId, roomTypeId, date) { await pool.query('DELETE FROM hotel_rate_overrides WHERE account_id=? AND room_type_id=? AND date=?', [accId, roomTypeId, date]) }

// ── Ocupación por noche (desde reservas activas) ────────────────────────────
// { 'YYYY-MM-DD': vendidas } para un tipo en [from, to).
async function soldPerNight(accId, roomTypeId, from, to) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(a.slot_start, '%Y-%m-%d') AS night, COUNT(*) AS sold
       FROM booking_allocations a JOIN calendar_bookings b ON b.id=a.booking_id
      WHERE a.account_id=? AND a.resource_id=? AND a.slot_start >= ? AND a.slot_start < ?
        AND b.status NOT IN ('cancelled','noshow')
      GROUP BY night`,
    [accId, roomTypeId, `${from} 00:00:00`, `${to} 00:00:00`]
  )
  const m = {}; for (const r of rows) m[r.night] = Number(r.sold); return m
}

// ── Disponibilidad / cotización de una estadía ──────────────────────────────
async function searchAvailability(accId, calId, { checkin, checkout, guests = 2 } = {}) {
  const nights = nightsBetween(checkin, checkout)
  if (!nights.length) throw new Error('Fechas inválidas (el check-out debe ser posterior al check-in)')
  const types = await listRoomTypes(accId, calId)
  const options = []
  for (const rt of types) {
    if ((rt.maxCapacity || rt.baseCapacity || 2) < guests) continue
    const [sold, ovr] = await Promise.all([soldPerNight(accId, rt.id, checkin, checkout), overridesFor(accId, rt.id, checkin, checkout)])
    const cap = (rt.totalRooms || 0) + (rt.overbookLimit || 0)
    if (!nights.every(n => (cap - (sold[n] || 0)) >= 1)) continue
    const q = quoteNights(nights, rt.basePrice, ovr)
    options.push({ roomTypeId: rt.id, name: rt.name, capacity: rt.maxCapacity, amenities: rt.amenities, nights: nights.length, currency: rt.currency, total: q.total, perNight: q.perNight })
  }
  return { checkin, checkout, guests, nights: nights.length, options }
}

async function quoteStay(accId, calId, { roomTypeId, checkin, checkout } = {}) {
  const rt = await getRoomType(accId, roomTypeId)
  if (!rt) throw new Error('Tipo de habitación no encontrado')
  const nights = nightsBetween(checkin, checkout)
  if (!nights.length) throw new Error('Fechas inválidas')
  const ovr = await overridesFor(accId, roomTypeId, checkin, checkout)
  const q = quoteNights(nights, rt.basePrice, ovr)
  return { roomTypeId, name: rt.name, checkin, checkout, nights: nights.length, currency: rt.currency, ...q }
}

// Reserva una estadía: crea la reserva (vertical hotel) + asignaciones por noche.
async function bookStay(accId, calId, { roomTypeId, checkin, checkout, guests = 2, ratePlan = 'BAR', client = {}, channel = 'web' } = {}) {
  const rt = await getRoomType(accId, roomTypeId)
  if (!rt) throw new Error('Tipo de habitación no encontrado')
  const nights = nightsBetween(checkin, checkout)
  if (!nights.length) throw new Error('Fechas inválidas')
  const sold = await soldPerNight(accId, roomTypeId, checkin, checkout)
  const cap = (rt.totalRooms || 0) + (rt.overbookLimit || 0)
  const full = nights.filter(n => (cap - (sold[n] || 0)) < 1)
  if (full.length) throw new Error(`Sin disponibilidad las noches: ${full.join(', ')}`)
  const ovr = await overridesFor(accId, roomTypeId, checkin, checkout)
  const q = quoteNights(nights, rt.basePrice, ovr)

  const id = 'bk_' + uid(); const ts = Date.now()
  let customerId = null
  try { const bk = require('./bookings'); customerId = await bk.findOrCreateCustomer(accId, { name: client.name, phone: client.phone, email: client.email }) } catch { /* opcional */ }
  const meta = { checkout, nights: nights.length, roomTypeId, roomType: rt.name, ratePlan, total: q.total, currency: rt.currency, perNight: q.perNight, guests }
  await pool.query(
    `INSERT INTO calendar_bookings (id, account_id, calendar_id, date, time, duration, party_size, checkout, client_name, client_phone, client_email, customer_id, channel, status, notes, meta, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, accId, calId, checkin, '', nights.length * 1440, guests, checkout,
     client.name || '', client.phone || '', client.email || '', customerId, channel, 'confirmed', '', JSON.stringify(meta), ts, ts]
  )
  for (const night of nights) {
    await pool.query('INSERT INTO booking_allocations (id, account_id, booking_id, resource_id, unit_key, slot_start, slot_end, qty) VALUES (?,?,?,?,?,?,?,?)',
      ['alloc_' + uid(), accId, id, roomTypeId, `${night}#${id}`, `${night} 00:00:00`, `${night} 23:59:59`, 1])
  }
  events.emit('BookingCreated', { accId, vertical: 'hotel', aggregateId: id, payload: { calendarId: calId, date: checkin, checkout, roomTypeId, nights: nights.length } }).catch(() => {})
  return { id, roomTypeId, roomType: rt.name, checkin, checkout, nights: nights.length, total: q.total, currency: rt.currency, status: 'confirmed' }
}

// Días del mes seleccionables como check-in (hay ≥1 tipo con cupo esa noche).
async function monthCheckinDays(accId, calId, year, month) {
  const y = Number(year), m = Number(month), mm = String(m).padStart(2, '0')
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const first = `${y}-${mm}-01`
  const nextMonthFirst = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`
  const types = await listRoomTypes(accId, calId)
  if (!types.length) return { year: y, month: m, days: [] }
  // Ocupación de TODAS las asignaciones del mes, agrupada por tipo+noche (1 query).
  const ids = types.map(t => t.id)
  const [rows] = await pool.query(
    `SELECT a.resource_id AS rt, DATE_FORMAT(a.slot_start,'%Y-%m-%d') AS night, COUNT(*) AS sold
       FROM booking_allocations a JOIN calendar_bookings b ON b.id=a.booking_id
      WHERE a.account_id=? AND a.resource_id IN (?) AND a.slot_start>=? AND a.slot_start<? AND b.status NOT IN ('cancelled','noshow')
      GROUP BY rt, night`,
    [accId, ids, `${first} 00:00:00`, `${nextMonthFirst} 00:00:00`]
  )
  const soldMap = {}; for (const r of rows) (soldMap[r.rt] ||= {})[r.night] = Number(r.sold)
  const capByType = Object.fromEntries(types.map(t => [t.id, (t.totalRooms || 0) + (t.overbookLimit || 0)]))
  const days = []
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${y}-${mm}-${String(d).padStart(2, '0')}`
    const anyFree = types.some(t => (capByType[t.id] - ((soldMap[t.id] || {})[ds] || 0)) >= 1)
    if (anyFree) days.push(ds)
  }
  return { year: y, month: m, days }
}

module.exports = {
  nightsBetween, quoteNights,
  listRoomTypes, getRoomType, createRoomType, updateRoomType, deleteRoomType,
  listRates, setRateRange, clearRate,
  searchAvailability, quoteStay, bookStay, monthCheckinDays, soldPerNight,
}
