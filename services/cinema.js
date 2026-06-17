'use strict'
/**
 * Servicio de Cine (Fase 3) — películas, salas (mapa de asientos), funciones,
 * mapa de asientos en vivo, holds con TTL (bloqueo durante el pago) y compra de
 * asientos. La unidad reservable es el ASIENTO de una FUNCIÓN: las asignaciones
 * usan booking_allocations (resource_id = showtimeId, unit_key = código de asiento)
 * y los holds usan la tabla `holds` (UNIQUE por asiento+función).
 */

const pool = require('../db')
const { uid, parseJ } = require('../utils')
const events = require('../core/events')

const HOLD_TTL_MIN = 7 // minutos que se reserva un asiento durante el pago

// ── Helper PURO: estados del mapa de asientos ───────────────────────────────
// config: { rows:[{row,count,type}], blocked:[codes] }. Devuelve filas con el
// estado de cada asiento: blocked|sold|held|free.
function buildSeatMap(config, soldSet, heldSet) {
  const blocked = new Set((config && config.blocked) || [])
  const rows = []
  for (const r of (config && config.rows) || []) {
    const seats = []
    for (let n = 1; n <= (Number(r.count) || 0); n++) {
      const code = `${r.row}${n}`
      const state = blocked.has(code) ? 'blocked' : soldSet.has(code) ? 'sold' : heldSet.has(code) ? 'held' : 'free'
      seats.push({ code, number: n, type: r.type || 'standard', state })
    }
    rows.push({ row: r.row, type: r.type || 'standard', seats })
  }
  const freeCount = rows.reduce((a, r) => a + r.seats.filter(s => s.state === 'free').length, 0)
  const totalCount = rows.reduce((a, r) => a + r.seats.length, 0)
  return { rows, freeCount, totalCount }
}

// ── Películas ────────────────────────────────────────────────────────────────
const mapMovie = r => r && ({ id: r.id, calendarId: r.calendar_id, title: r.title, durationMin: r.duration_min, rating: r.rating, poster: r.poster, synopsis: r.synopsis, status: r.status })
async function listMovies(accId, calId) {
  const [rows] = await pool.query("SELECT * FROM cine_movies WHERE account_id=? AND calendar_id=? AND status<>'inactive' ORDER BY title ASC", [accId, calId])
  return rows.map(mapMovie)
}
async function createMovie(accId, calId, b = {}) {
  const id = 'mov_' + uid(); const ts = Date.now()
  await pool.query('INSERT INTO cine_movies (id, account_id, calendar_id, title, duration_min, rating, poster, synopsis, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.title || 'Película', Number(b.durationMin) || 120, b.rating || '', b.poster || '', b.synopsis || '', 'active', ts, ts])
  const [[r]] = await pool.query('SELECT * FROM cine_movies WHERE id=?', [id]); return mapMovie(r)
}
async function updateMovie(accId, id, b = {}) {
  const map = { title: 'title', durationMin: 'duration_min', rating: 'rating', poster: 'poster', synopsis: 'synopsis', status: 'status' }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
  await pool.query(`UPDATE cine_movies SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteMovie(accId, id) { await pool.query('DELETE FROM cine_movies WHERE id=? AND account_id=?', [id, accId]) }

// ── Salas (auditoriums) ───────────────────────────────────────────────────────
const mapAud = r => r && ({ id: r.id, calendarId: r.calendar_id, name: r.name, screenType: r.screen_type, seatMap: parseJ(r.seat_map, { rows: [], blocked: [] }) })
async function listAuditoriums(accId, calId) {
  const [rows] = await pool.query('SELECT * FROM cine_auditoriums WHERE account_id=? AND calendar_id=? ORDER BY name ASC', [accId, calId])
  return rows.map(mapAud)
}
async function getAuditorium(accId, id) { const [[r]] = await pool.query('SELECT * FROM cine_auditoriums WHERE id=? AND account_id=?', [id, accId]); return mapAud(r) }
async function createAuditorium(accId, calId, b = {}) {
  const id = 'aud_' + uid(); const ts = Date.now()
  await pool.query('INSERT INTO cine_auditoriums (id, account_id, calendar_id, name, screen_type, seat_map, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.name || 'Sala', b.screenType || '2D', JSON.stringify(b.seatMap || { rows: [], blocked: [] }), ts, ts])
  return getAuditorium(accId, id)
}
async function updateAuditorium(accId, id, b = {}) {
  const sets = []; const vals = []
  if (b.name !== undefined) { sets.push('name=?'); vals.push(b.name) }
  if (b.screenType !== undefined) { sets.push('screen_type=?'); vals.push(b.screenType) }
  if (b.seatMap !== undefined) { sets.push('seat_map=?'); vals.push(JSON.stringify(b.seatMap)) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
  await pool.query(`UPDATE cine_auditoriums SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteAuditorium(accId, id) { await pool.query('DELETE FROM cine_auditoriums WHERE id=? AND account_id=?', [id, accId]) }

// ── Funciones (showtimes) ─────────────────────────────────────────────────────
const mapShow = r => r && ({ id: r.id, calendarId: r.calendar_id, movieId: r.movie_id, auditoriumId: r.auditorium_id, date: r.date, time: r.time, format: r.format, language: r.language, price: r.price != null ? Number(r.price) : null, status: r.status })
async function listShowtimes(accId, calId, { date, movieId, from, to } = {}) {
  const where = ['account_id=?', 'calendar_id=?', "status<>'inactive'"]; const params = [accId, calId]
  if (date) { where.push('date=?'); params.push(date) }
  if (movieId) { where.push('movie_id=?'); params.push(movieId) }
  if (from) { where.push('date>=?'); params.push(from) }
  if (to) { where.push('date<=?'); params.push(to) }
  const [rows] = await pool.query(`SELECT * FROM cine_showtimes WHERE ${where.join(' AND ')} ORDER BY date ASC, time ASC`, params)
  return rows.map(mapShow)
}
async function getShowtime(accId, id) { const [[r]] = await pool.query('SELECT * FROM cine_showtimes WHERE id=? AND account_id=?', [id, accId]); return mapShow(r) }
async function createShowtime(accId, calId, b = {}) {
  const id = 'show_' + uid(); const ts = Date.now()
  await pool.query('INSERT INTO cine_showtimes (id, account_id, calendar_id, movie_id, auditorium_id, date, time, format, language, price, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.movieId || null, b.auditoriumId || null, b.date || '', b.time || '', b.format || '2D', b.language || '', b.price != null ? Number(b.price) : null, 'active', ts, ts])
  return getShowtime(accId, id)
}
async function updateShowtime(accId, id, b = {}) {
  const map = { movieId: 'movie_id', auditoriumId: 'auditorium_id', date: 'date', time: 'time', format: 'format', language: 'language', price: 'price', status: 'status' }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
  await pool.query(`UPDATE cine_showtimes SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteShowtime(accId, id) { await pool.query('DELETE FROM cine_showtimes WHERE id=? AND account_id=?', [id, accId]) }

// ── Asientos vendidos / en hold de una función ──────────────────────────────
async function soldSeats(accId, showtimeId) {
  const [rows] = await pool.query(
    `SELECT a.unit_key FROM booking_allocations a JOIN calendar_bookings b ON b.id=a.booking_id
      WHERE a.account_id=? AND a.resource_id=? AND b.status NOT IN ('cancelled','noshow')`,
    [accId, showtimeId]
  )
  return new Set(rows.map(r => r.unit_key))
}
async function heldSeats(accId, showtimeId) {
  const [rows] = await pool.query('SELECT unit_key FROM holds WHERE account_id=? AND resource_id=? AND expires_at>?', [accId, showtimeId, Date.now()])
  return new Set(rows.map(r => r.unit_key))
}

// Mapa de asientos en vivo de una función (estado por asiento).
async function getSeatMap(accId, showtimeId) {
  const show = await getShowtime(accId, showtimeId)
  if (!show) throw new Error('Función no encontrada')
  const aud = await getAuditorium(accId, show.auditoriumId)
  const [sold, held] = await Promise.all([soldSeats(accId, showtimeId), heldSeats(accId, showtimeId)])
  const map = buildSeatMap(aud?.seatMap || { rows: [], blocked: [] }, sold, held)
  return { showtime: show, screenType: aud?.screenType || show.format, ...map }
}

// Bloquea asientos temporalmente (hold). Devuelve { ok, held, failed, expiresAt }.
async function holdSeats(accId, showtimeId, seats = [], { sessionId, ttlMin = HOLD_TTL_MIN } = {}) {
  const list = [...new Set((seats || []).filter(Boolean))]
  if (!list.length) return { ok: false, held: [], failed: [], error: 'Sin asientos' }
  const show = await getShowtime(accId, showtimeId)
  if (!show) return { ok: false, held: [], failed: list, error: 'Función no encontrada' }
  const [sold, held] = await Promise.all([soldSeats(accId, showtimeId), heldSeats(accId, showtimeId)])
  const taken = list.filter(s => sold.has(s) || held.has(s))
  if (taken.length) return { ok: false, held: [], failed: taken, error: 'Asientos no disponibles' }
  const expiresAt = Date.now() + Math.max(1, ttlMin) * 60000
  const slotStart = `${show.date} ${show.time || '00:00'}:00`
  const okSeats = []
  for (const code of list) {
    try {
      await pool.query('INSERT INTO holds (id, account_id, vertical, resource_id, unit_key, slot_start, expires_at, session_id) VALUES (?,?,?,?,?,?,?,?)',
        ['hold_' + uid(), accId, 'cinema', showtimeId, code, slotStart, expiresAt, sessionId || null])
      okSeats.push(code)
    } catch { /* carrera: otro lo tomó */ }
  }
  if (okSeats.length !== list.length) {
    // rollback de los que sí entraron
    if (okSeats.length) await pool.query('DELETE FROM holds WHERE account_id=? AND resource_id=? AND unit_key IN (?)', [accId, showtimeId, okSeats]).catch(() => {})
    return { ok: false, held: [], failed: list.filter(s => !okSeats.includes(s)), error: 'Asientos no disponibles' }
  }
  events.emit('SeatReserved', { accId, vertical: 'cinema', aggregateId: showtimeId, payload: { seats: okSeats, hold: true } }).catch(() => {})
  return { ok: true, held: okSeats, failed: [], expiresAt }
}

async function releaseHold(accId, showtimeId, seats = [], sessionId) {
  const where = ['account_id=?', 'resource_id=?']; const params = [accId, showtimeId]
  if (seats && seats.length) { where.push('unit_key IN (?)'); params.push(seats) }
  if (sessionId) { where.push('session_id=?'); params.push(sessionId) }
  await pool.query(`DELETE FROM holds WHERE ${where.join(' AND ')}`, params)
}

// Borra holds vencidos (lo llama el worker). Devuelve nº borrados.
async function releaseExpiredHolds() {
  try { const [r] = await pool.query('DELETE FROM holds WHERE expires_at < ?', [Date.now()]); return r?.affectedRows || 0 }
  catch { return 0 }
}

// Compra asientos: crea la reserva (vertical cinema) + asignaciones + libera holds.
async function bookSeats(accId, showtimeId, seats = [], client = {}, { sessionId, channel = 'web' } = {}) {
  const list = [...new Set((seats || []).filter(Boolean))]
  if (!list.length) throw new Error('Selecciona al menos un asiento')
  const show = await getShowtime(accId, showtimeId)
  if (!show) throw new Error('Función no encontrada')
  const sold = await soldSeats(accId, showtimeId)
  const clash = list.filter(s => sold.has(s))
  if (clash.length) throw new Error(`Asientos ya vendidos: ${clash.join(', ')}`)

  const movie = show.movieId ? (await pool.query('SELECT title, duration_min FROM cine_movies WHERE id=?', [show.movieId]))[0][0] : null
  const id = 'bk_' + uid(); const ts = Date.now()
  let customerId = null
  try { const bk = require('./bookings'); customerId = await bk.findOrCreateCustomer(accId, { name: client.name, phone: client.phone, email: client.email }) } catch { /* opcional */ }
  const meta = { showtimeId, seats: list, movie: movie?.title || '', format: show.format, auditoriumId: show.auditoriumId }
  await pool.query(
    `INSERT INTO calendar_bookings (id, account_id, calendar_id, date, time, duration, party_size, client_name, client_phone, client_email, customer_id, channel, status, notes, meta, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, accId, show.calendarId, show.date, show.time, Number(movie?.duration_min) || 0, list.length,
     client.name || '', client.phone || '', client.email || '', customerId, channel, 'confirmed', '', JSON.stringify(meta), ts, ts]
  )
  // Asientos como asignaciones (UNIQUE evita doble venta en carrera).
  const failed = []
  for (const code of list) {
    try {
      await pool.query('INSERT INTO booking_allocations (id, account_id, booking_id, resource_id, unit_key, slot_start, qty) VALUES (?,?,?,?,?,?,?)',
        ['alloc_' + uid(), accId, id, showtimeId, code, `${show.date} ${show.time || '00:00'}:00`, 1])
    } catch { failed.push(code) }
  }
  if (failed.length) {
    // alguien compró un asiento en la carrera → revertir todo
    await pool.query('DELETE FROM booking_allocations WHERE booking_id=?', [id]).catch(() => {})
    await pool.query('DELETE FROM calendar_bookings WHERE id=?', [id]).catch(() => {})
    throw new Error(`Asientos ya no disponibles: ${failed.join(', ')}`)
  }
  await releaseHold(accId, showtimeId, list, sessionId)
  events.emit('BookingCreated', { accId, vertical: 'cinema', aggregateId: id, payload: { calendarId: show.calendarId, date: show.date, time: show.time, showtimeId, seats: list } }).catch(() => {})
  return { id, showtimeId, date: show.date, time: show.time, seats: list, status: 'confirmed' }
}

module.exports = {
  buildSeatMap, HOLD_TTL_MIN,
  listMovies, createMovie, updateMovie, deleteMovie,
  listAuditoriums, getAuditorium, createAuditorium, updateAuditorium, deleteAuditorium,
  listShowtimes, getShowtime, createShowtime, updateShowtime, deleteShowtime,
  getSeatMap, holdSeats, releaseHold, releaseExpiredHolds, bookSeats,
}
