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
  description: r.description || '', photos: parseJ(r.photos, []),
  externalProvider: r.external_provider || null, externalRef: r.external_ref || null,
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
  const map = { name: 'name', baseCapacity: 'base_capacity', maxCapacity: 'max_capacity', totalRooms: 'total_rooms', overbookLimit: 'overbook_limit', basePrice: 'base_price', currency: 'currency', status: 'status', description: 'description' }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  if (b.amenities !== undefined) { sets.push('amenities=?'); vals.push(JSON.stringify(b.amenities)) }
  if (b.photos !== undefined) { sets.push('photos=?'); vals.push(JSON.stringify(b.photos)) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
  await pool.query(`UPDATE hotel_room_types SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteRoomType(accId, id) { await pool.query('DELETE FROM hotel_room_types WHERE id=? AND account_id=?', [id, accId]) }

// Crea o actualiza un tipo de habitación importado de una OTA (por external_ref).
// Devuelve el id de nuestro tipo. ext = { externalId, name, description, capacity,
// maxCapacity, totalRooms, basePrice, currency, amenities[], photos[] }
async function upsertExternalRoomType(accId, calId, provider, ext = {}) {
  const [[exist]] = await pool.query('SELECT id FROM hotel_room_types WHERE account_id=? AND calendar_id=? AND external_provider=? AND external_ref=? LIMIT 1', [accId, calId, provider, String(ext.externalId || '')])
  const ts = Date.now()
  const cap = Number(ext.maxCapacity || ext.capacity) || 2
  if (exist) {
    // Actualiza ficha; total_rooms/base_price solo si vinieron (no pisar config local).
    const sets = ['name=?', 'description=?', 'base_capacity=?', 'max_capacity=?', 'currency=?', 'amenities=?', 'photos=?', 'updated_at=?']
    const vals = [ext.name || 'Habitación', ext.description || '', Number(ext.capacity) || cap, cap, ext.currency || 'USD', JSON.stringify(ext.amenities || []), JSON.stringify(ext.photos || []), ts]
    if (ext.totalRooms != null) { sets.push('total_rooms=?'); vals.push(Number(ext.totalRooms)) }
    if (ext.basePrice != null) { sets.push('base_price=?'); vals.push(Number(ext.basePrice)) }
    vals.push(exist.id)
    await pool.query(`UPDATE hotel_room_types SET ${sets.join(',')} WHERE id=?`, vals)
    return exist.id
  }
  const id = 'rt_' + uid()
  await pool.query(
    'INSERT INTO hotel_room_types (id, account_id, calendar_id, name, base_capacity, max_capacity, total_rooms, overbook_limit, base_price, currency, amenities, description, photos, external_provider, external_ref, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, ext.name || 'Habitación', Number(ext.capacity) || cap, cap, Number(ext.totalRooms) || 1, 0, Number(ext.basePrice) || 0, ext.currency || 'USD', JSON.stringify(ext.amenities || []), ext.description || '', JSON.stringify(ext.photos || []), provider, String(ext.externalId || ''), 'active', ts, ts]
  )
  return id
}

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

// Habitaciones físicas fuera de servicio (mantenimiento abierto) por noche.
async function oosPerNight(accId, roomTypeId, nights) {
  if (!nights.length) return {}
  let rows
  try {
    [rows] = await pool.query(
      `SELECT m.oos_from, m.oos_to FROM maintenance_tickets m JOIN hotel_rooms r ON r.id=m.room_id
        WHERE m.account_id=? AND r.room_type_id=? AND m.status='open'`,
      [accId, roomTypeId]
    )
  } catch { return {} }
  const m = {}
  for (const t of rows || []) {
    for (const n of nights) {
      if ((!t.oos_from || t.oos_from <= n) && (!t.oos_to || t.oos_to >= n)) m[n] = (m[n] || 0) + 1
    }
  }
  return m
}

// ── Habitaciones físicas (disponibilidad por habitación concreta) ───────────
// Si un tipo tiene habitaciones físicas definidas, la disponibilidad y la
// asignación se hacen por habitación concreta (no por contador de cupo).
async function physicalRooms(accId, roomTypeId, conn = pool) {
  const [rows] = await conn.query("SELECT id, number, hk_status FROM hotel_rooms WHERE account_id=? AND room_type_id=? AND status<>'inactive'", [accId, roomTypeId])
  return rows
}
// Habitaciones físicas de un tipo ya asignadas a estadías que solapan [ci, co).
async function occupiedRoomIds(accId, roomTypeId, ci, co, conn = pool) {
  const [rows] = await conn.query(
    `SELECT DISTINCT b.room_id FROM calendar_bookings b
      WHERE b.account_id=? AND b.room_id IS NOT NULL AND b.status NOT IN ('cancelled','noshow')
        AND b.date < ? AND (b.checkout IS NULL OR b.checkout > ?)
        AND b.room_id IN (SELECT id FROM hotel_rooms WHERE account_id=? AND room_type_id=?)`,
    [accId, co, ci, accId, roomTypeId]
  )
  return new Set(rows.map(r => r.room_id))
}
// Habitaciones físicas libres para la estadía. null = el tipo no usa hab. físicas.
async function freePhysicalRooms(accId, roomTypeId, ci, co, conn = pool) {
  const rooms = await physicalRooms(accId, roomTypeId, conn)
  if (!rooms.length) return null
  const occ = await occupiedRoomIds(accId, roomTypeId, ci, co, conn)
  return rooms.filter(r => r.hk_status !== 'oos' && !occ.has(r.id))
}
// ¿Hay disponibilidad del tipo para la estadía? (físicas si existen, si no, cupo).
async function typeAvailable(accId, rt, nights, ci, co, conn = pool) {
  const free = await freePhysicalRooms(accId, rt.id, ci, co, conn)
  if (free !== null) return { ok: free.length >= 1, room: free[0] || null }
  const [sold, oos] = await Promise.all([soldPerNight(accId, rt.id, ci, co), oosPerNight(accId, rt.id, nights)])
  const cap = (rt.totalRooms || 0) + (rt.overbookLimit || 0)
  return { ok: nights.every(n => (cap - (sold[n] || 0) - (oos[n] || 0)) >= 1), room: null }
}

// ── Disponibilidad / cotización de una estadía ──────────────────────────────
async function searchAvailability(accId, calId, { checkin, checkout, guests = 2 } = {}) {
  const nights = nightsBetween(checkin, checkout)
  if (!nights.length) throw new Error('Fechas inválidas (el check-out debe ser posterior al check-in)')
  const types = await listRoomTypes(accId, calId)
  const options = []
  for (const rt of types) {
    if ((rt.maxCapacity || rt.baseCapacity || 2) < guests) continue
    const avail = await typeAvailable(accId, rt, nights, checkin, checkout)
    if (!avail.ok) continue
    const ovr = await overridesFor(accId, rt.id, checkin, checkout)
    const q = quoteNights(nights, rt.basePrice, ovr)
    options.push({ roomTypeId: rt.id, name: rt.name, capacity: rt.maxCapacity, amenities: rt.amenities, description: rt.description, photos: rt.photos, nights: nights.length, currency: rt.currency, total: q.total, perNight: q.perNight })
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

// Reserva una estadía de forma TRANSACCIONAL (anti-overbooking): bloquea la fila
// del tipo de habitación (FOR UPDATE), revalida cupo/habitación física y, si
// procede, crea la reserva + asignaciones por noche. Asigna una habitación física
// concreta si el tipo las usa.
async function bookStay(accId, calId, { roomTypeId, checkin, checkout, guests = 2, ratePlan = 'BAR', client = {}, channel = 'web' } = {}) {
  const nights = nightsBetween(checkin, checkout)
  if (!nights.length) throw new Error('Fechas inválidas')
  let customerId = null
  try { const bk = require('./bookings'); customerId = await bk.findOrCreateCustomer(accId, { name: client.name, phone: client.phone, email: client.email }) } catch { /* opcional */ }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Mutex por tipo de habitación → serializa las reservas concurrentes del tipo.
    const [[rtRow]] = await conn.query('SELECT * FROM hotel_room_types WHERE id=? AND account_id=? FOR UPDATE', [roomTypeId, accId])
    if (!rtRow) throw new Error('Tipo de habitación no encontrado')
    const rt = mapRT(rtRow)
    const avail = await typeAvailable(accId, rt, nights, checkin, checkout, conn)
    if (!avail.ok) throw new Error('Sin disponibilidad para esas fechas')
    const roomId = avail.room ? avail.room.id : null

    const ovr = await overridesFor(accId, roomTypeId, checkin, checkout)
    const q = quoteNights(nights, rt.basePrice, ovr)
    const id = 'bk_' + uid(); const ts = Date.now()
    const meta = { checkout, nights: nights.length, roomTypeId, roomType: rt.name, ratePlan, total: q.total, currency: rt.currency, perNight: q.perNight, guests }
    await conn.query(
      `INSERT INTO calendar_bookings (id, account_id, calendar_id, date, time, duration, party_size, checkout, room_id, client_name, client_phone, client_email, customer_id, channel, status, notes, meta, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, accId, calId, checkin, '', nights.length * 1440, guests, checkout, roomId,
       client.name || '', client.phone || '', client.email || '', customerId, channel, 'confirmed', '', JSON.stringify(meta), ts, ts]
    )
    for (const night of nights) {
      await conn.query('INSERT INTO booking_allocations (id, account_id, booking_id, resource_id, unit_key, slot_start, slot_end, qty) VALUES (?,?,?,?,?,?,?,?)',
        ['alloc_' + uid(), accId, id, roomTypeId, `${night}#${id}`, `${night} 00:00:00`, `${night} 23:59:59`, 1])
    }
    await conn.commit()
    events.emit('BookingCreated', { accId, vertical: 'hotel', aggregateId: id, payload: { calendarId: calId, date: checkin, checkout, roomTypeId, roomId, nights: nights.length } }).catch(() => {})
    return { id, roomTypeId, roomType: rt.name, roomId, checkin, checkout, nights: nights.length, total: q.total, currency: rt.currency, status: 'confirmed' }
  } catch (e) {
    try { await conn.rollback() } catch {}
    throw e
  } finally {
    conn.release()
  }
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

// Reserva para la IA: busca disponibilidad, elige el tipo (por nombre o el más
// económico que acomode) y reserva.
async function autoBook(accId, calId, { roomType, checkin, checkout, guests = 2, client = {} } = {}) {
  const { options } = await searchAvailability(accId, calId, { checkin, checkout, guests })
  if (!options.length) throw new Error('No hay habitaciones disponibles para esas fechas.')
  let opt = null
  if (roomType) opt = options.find(o => (o.name || '').toLowerCase().includes(String(roomType).toLowerCase()))
  opt = opt || options[0] // searchAvailability ordena por precio asc → el más económico
  return bookStay(accId, calId, { roomTypeId: opt.roomTypeId, checkin, checkout, guests, client, channel: 'flow' })
}

module.exports = {
  nightsBetween, quoteNights,
  listRoomTypes, getRoomType, createRoomType, updateRoomType, deleteRoomType, upsertExternalRoomType,
  listRates, setRateRange, clearRate,
  searchAvailability, quoteStay, bookStay, autoBook, monthCheckinDays, soldPerNight,
}
