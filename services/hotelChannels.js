'use strict'
/**
 * Gestión de canales / OTAs del hotel — Airbnb, HosRoom, Booking.com, Kunas.
 *
 * Dos mecanismos de integración:
 *  1) iCal de doble vía (universal, funciona ya):
 *     - EXPORT: una URL .ics pública por tipo de habitación con las fechas
 *       ocupadas → la OTA se suscribe y bloquea esas fechas.
 *     - IMPORT: leemos la URL iCal de la OTA y creamos "reservas externas" que
 *       bloquean nuestra disponibilidad.
 *  2) Reservas entrantes (webhook normalizado) + adaptadores de API por proveedor
 *     (HosRoom/Kunas/Booking-Connectivity) que se activan al cargar credenciales.
 *
 * Las reservas externas son calendar_bookings (vertical hotel) con channel=provider
 * y channel_ref/ical_uid para deduplicar. Bloquean disponibilidad porque cuentan
 * en soldPerNight / habitaciones físicas como cualquier reserva activa.
 */

const pool = require('../db')
const { uid, parseJ } = require('../utils')
const hotel = require('./hotel')

const PROVIDERS = ['airbnb', 'hosroom', 'booking', 'kunas']

// ── CRUD de canales ───────────────────────────────────────────────────────────
const mapCh = r => r && ({
  id: r.id, calendarId: r.calendar_id, provider: r.provider, name: r.name,
  enabled: !!r.enabled, config: parseJ(r.config, {}), lastSync: r.last_sync, lastResult: r.last_result,
})
async function listChannels(accId, calId) {
  const [rows] = await pool.query('SELECT * FROM hotel_channels WHERE account_id=? AND calendar_id=? ORDER BY provider ASC', [accId, calId])
  // No exponemos secretos crudos completos al panel (se mantienen, solo se enmascaran fuera).
  return rows.map(mapCh)
}
async function getChannel(accId, id) { const [[r]] = await pool.query('SELECT * FROM hotel_channels WHERE id=? AND account_id=?', [id, accId]); return mapCh(r) }
async function createChannel(accId, calId, b = {}) {
  if (!PROVIDERS.includes(b.provider)) throw new Error('Proveedor no soportado')
  const id = 'chan_' + uid(); const ts = Date.now()
  const config = b.config || {}
  if (!config.webhookSecret) config.webhookSecret = uid() + uid() // secreto para el webhook entrante
  await pool.query('INSERT INTO hotel_channels (id, account_id, calendar_id, provider, name, enabled, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.provider, b.name || b.provider, b.enabled === false ? 0 : 1, JSON.stringify(config), ts, ts])
  return getChannel(accId, id)
}
async function updateChannel(accId, id, b = {}) {
  const cur = await getChannel(accId, id)
  if (!cur) return
  const sets = []; const vals = []
  if (b.name !== undefined) { sets.push('name=?'); vals.push(b.name) }
  if (b.enabled !== undefined) { sets.push('enabled=?'); vals.push(b.enabled ? 1 : 0) }
  if (b.config !== undefined) { sets.push('config=?'); vals.push(JSON.stringify({ ...cur.config, ...b.config })) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
  await pool.query(`UPDATE hotel_channels SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteChannel(accId, id) { await pool.query('DELETE FROM hotel_channels WHERE id=? AND account_id=?', [id, accId]) }

// ── iCal EXPORT (nuestras fechas ocupadas → la OTA las bloquea) ─────────────
const fmtICalDate = d => String(d).replace(/-/g, '') // YYYY-MM-DD → YYYYMMDD
const icalEscape = s => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
function nowStamp() { return new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z' }

async function buildIcal(accId, calId, roomTypeId) {
  // Reservas activas de ese tipo (incluye las externas importadas).
  const [rows] = await pool.query(
    "SELECT b.id, b.date AS checkin, b.checkout, b.channel, b.client_name FROM calendar_bookings b WHERE b.account_id=? AND b.calendar_id=? AND b.status NOT IN ('cancelled','noshow') AND b.id IN (SELECT booking_id FROM booking_allocations WHERE account_id=? AND resource_id=?)",
    [accId, calId, accId, roomTypeId]
  )
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AVI Platform//Hotel//ES', 'CALSCALE:GREGORIAN']
  for (const r of rows) {
    if (!r.checkin || !r.checkout) continue
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${r.id}@aviplatform`)
    lines.push(`DTSTAMP:${nowStamp()}`)
    lines.push(`DTSTART;VALUE=DATE:${fmtICalDate(r.checkin)}`)
    lines.push(`DTEND;VALUE=DATE:${fmtICalDate(r.checkout)}`)
    lines.push(`SUMMARY:${icalEscape(r.channel && r.channel !== 'web' ? `Reservado (${r.channel})` : 'Reservado')}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

// ── iCal IMPORT (parser mínimo de VEVENT) ────────────────────────────────────
function parseIcalDate(val) {
  const m = String(val).match(/(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
function parseIcal(text) {
  // Desdobla líneas plegadas (continuación con espacio/tab inicial).
  const raw = String(text).replace(/\r\n[ \t]/g, '').split(/\r?\n/)
  const events = []; let cur = null
  for (const line of raw) {
    if (line.startsWith('BEGIN:VEVENT')) cur = {}
    else if (line.startsWith('END:VEVENT')) { if (cur && cur.start && cur.end) events.push(cur); cur = null }
    else if (cur) {
      const idx = line.indexOf(':'); if (idx < 0) continue
      const key = line.slice(0, idx).split(';')[0].toUpperCase(); const val = line.slice(idx + 1)
      if (key === 'DTSTART') cur.start = parseIcalDate(val)
      else if (key === 'DTEND') cur.end = parseIcalDate(val)
      else if (key === 'UID') cur.uid = val.trim()
      else if (key === 'SUMMARY') cur.summary = val.trim()
    }
  }
  return events
}

// Crea/actualiza una reserva EXTERNA que bloquea disponibilidad (por noche).
async function upsertExternalStay(accId, calId, { roomTypeId, checkin, checkout, provider, ref, uid: icalUid, guestName, guests = 1, total, currency }) {
  const nights = hotel.nightsBetween(checkin, checkout)
  if (!nights.length || !roomTypeId) return null
  // Dedup por ical_uid o channel_ref.
  const dedupKey = icalUid || ref
  if (dedupKey) {
    const [[ex]] = await pool.query('SELECT id, date, checkout FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND (ical_uid=? OR channel_ref=?) LIMIT 1', [accId, calId, icalUid || '', ref || ''])
    if (ex) {
      if (ex.date !== checkin || ex.checkout !== checkout) {
        await pool.query('DELETE FROM booking_allocations WHERE booking_id=? AND account_id=?', [ex.id, accId])
        await pool.query('UPDATE calendar_bookings SET date=?, checkout=?, updated_at=? WHERE id=?', [checkin, checkout, Date.now(), ex.id])
        for (const n of nights) await pool.query('INSERT INTO booking_allocations (id, account_id, booking_id, resource_id, unit_key, slot_start, slot_end, qty) VALUES (?,?,?,?,?,?,?,?)', ['alloc_' + uid(), accId, ex.id, roomTypeId, `${n}#${ex.id}`, `${n} 00:00:00`, `${n} 23:59:59`, 1])
      }
      return ex.id
    }
  }
  const rt = await hotel.getRoomType(accId, roomTypeId)
  const id = 'bk_' + uid(); const ts = Date.now()
  const meta = { checkout, nights: nights.length, roomTypeId, roomType: rt?.name || '', external: true, provider, total, currency: currency || rt?.currency || 'USD', guests }
  await pool.query(
    `INSERT INTO calendar_bookings (id, account_id, calendar_id, date, time, duration, party_size, checkout, channel, channel_ref, ical_uid, client_name, status, notes, meta, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, accId, calId, checkin, '', nights.length * 1440, guests, checkout, provider, ref || null, icalUid || null, guestName || provider, 'confirmed', '', JSON.stringify(meta), ts, ts]
  )
  for (const n of nights) await pool.query('INSERT INTO booking_allocations (id, account_id, booking_id, resource_id, unit_key, slot_start, slot_end, qty) VALUES (?,?,?,?,?,?,?,?)', ['alloc_' + uid(), accId, id, roomTypeId, `${n}#${id}`, `${n} 00:00:00`, `${n} 23:59:59`, 1])
  return id
}

// Importa el iCal de un canal (bloquea las fechas de la OTA en nuestro sistema).
async function importIcal(accId, channel) {
  const url = channel.config?.icalImportUrl
  const roomTypeId = channel.config?.roomTypeId
  if (!url) return { ok: false, error: 'Sin URL iCal' }
  if (!roomTypeId) return { ok: false, error: 'Falta mapear el tipo de habitación' }
  const res = await fetch(url)
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  const text = await res.text()
  const events = parseIcal(text)
  let imported = 0
  for (const e of events) {
    // Algunas OTAs exportan bloqueos "Not available" además de reservas → igual bloquean.
    try { await upsertExternalStay(accId, channel.calendarId, { roomTypeId, checkin: e.start, checkout: e.end, provider: channel.provider, uid: e.uid, guestName: e.summary || channel.provider }); imported++ } catch { /* skip */ }
  }
  return { ok: true, imported, total: events.length }
}

// ── Reserva entrante (webhook normalizado / pull API) ───────────────────────
// payload normalizado: { ref, roomTypeId, checkin, checkout, guests, guestName, guestPhone, guestEmail, total, currency }
async function inboundReservation(accId, calId, provider, payload = {}) {
  const roomTypeId = payload.roomTypeId || (await defaultRoomType(accId, calId))
  if (!roomTypeId) throw new Error('No hay tipo de habitación para asignar la reserva')
  const id = await upsertExternalStay(accId, calId, {
    roomTypeId, checkin: payload.checkin, checkout: payload.checkout, provider,
    ref: payload.ref, guestName: payload.guestName, guests: Number(payload.guests) || 1,
    total: payload.total, currency: payload.currency,
  })
  if (!id) throw new Error('Datos de reserva inválidos (fechas/tipo)')
  return { id, provider, ref: payload.ref }
}
async function defaultRoomType(accId, calId) { const types = await hotel.listRoomTypes(accId, calId); return types[0]?.id }

// ── Adaptadores de API reales por proveedor ─────────────────────────────────
const channelAdapters = require('./channels')

function providerSchemas() { return channelAdapters.providerSchemas() }

async function testConnection(accId, channelId) {
  const channel = await getChannel(accId, channelId)
  if (!channel) throw new Error('Canal no encontrado')
  const a = channelAdapters.getAdapter(channel.provider)
  if (!a) return { ok: false, message: 'Proveedor no soportado' }
  return a.testConnection(channel.config || {})
}

// Importa la ficha de habitaciones (con fotos/descripción/amenidades) desde la OTA,
// crea/actualiza nuestros tipos y construye el mapeo externalId → nuestro tipo.
async function syncRoomTypes(accId, channel) {
  const a = channelAdapters.getAdapter(channel.provider)
  if (!a) return { ok: false, error: 'Proveedor no soportado', rooms: 0 }
  let list = []
  try { list = await a.importRoomTypes(channel.config || {}) } catch (e) { return { ok: false, error: e.message, rooms: 0 } }
  const map = { ...(channel.config?.roomTypeMap || {}) }
  let first = null
  for (const ext of list) {
    try {
      const id = await hotel.upsertExternalRoomType(accId, channel.calendarId, channel.provider, ext)
      map[String(ext.externalId)] = id
      if (!first) first = id
    } catch (e) { console.warn('[syncRoomTypes]', e.message) }
  }
  // Persiste el mapeo y un tipo por defecto si no había.
  const cfgPatch = { roomTypeMap: map }
  if (!channel.config?.roomTypeId && first) cfgPatch.roomTypeId = first
  await updateChannel(accId, channel.id, { config: cfgPatch })
  return { ok: true, rooms: list.length }
}

// Cancela una reserva externa por su referencia (la OTA la canceló).
async function cancelExternal(accId, calId, ref) {
  const [[b]] = await pool.query("SELECT id FROM calendar_bookings WHERE account_id=? AND calendar_id=? AND channel_ref=? AND status NOT IN ('cancelled') LIMIT 1", [accId, calId, ref])
  if (!b) return
  await pool.query('UPDATE calendar_bookings SET status=? , updated_at=? WHERE id=?', ['cancelled', Date.now(), b.id])
  await pool.query('DELETE FROM booking_allocations WHERE booking_id=? AND account_id=?', [b.id, accId]).catch(() => {})
}

// Importa reservas vía API del proveedor (mapeando habitación externa → tipo).
async function syncReservations(accId, channel) {
  const a = channelAdapters.getAdapter(channel.provider)
  if (!a) return { ok: false, error: 'Proveedor no soportado', imported: 0 }
  let list = []
  try { list = await a.importReservations(channel.config || {}) } catch (e) { return { ok: false, error: e.message, imported: 0 } }
  const map = channel.config?.roomTypeMap || {}
  const fallback = channel.config?.roomTypeId
  let imported = 0
  for (const r of list) {
    try {
      if (r.status === 'cancelled') { await cancelExternal(accId, channel.calendarId, r.ref); continue }
      const roomTypeId = map[String(r.externalRoomId)] || fallback
      if (!roomTypeId || !r.checkin || !r.checkout) continue
      await upsertExternalStay(accId, channel.calendarId, {
        roomTypeId, checkin: r.checkin, checkout: r.checkout, provider: channel.provider,
        ref: r.ref, guestName: r.guestName, guests: Number(r.guests) || 1, total: r.total, currency: r.currency,
      })
      imported++
    } catch (e) { console.warn('[syncReservations]', e.message) }
  }
  return { ok: true, imported }
}

// Importa disponibilidad/tarifas → aplica precios por noche al tipo mapeado.
async function syncAvailability(accId, channel) {
  const a = channelAdapters.getAdapter(channel.provider)
  if (!a || !a.importAvailability) return { ok: true, rates: 0 }
  let list = []
  try { list = await a.importAvailability(channel.config || {}, {}) } catch { return { ok: true, rates: 0 } }
  const map = channel.config?.roomTypeMap || {}
  let rates = 0
  for (const it of list) {
    const roomTypeId = map[String(it.externalRoomId)] || channel.config?.roomTypeId
    if (!roomTypeId || !it.date) continue
    if (it.price != null && Number(it.price) > 0) {
      try { await hotel.setRateRange(accId, roomTypeId, it.date, it.date, Number(it.price)); rates++ } catch {}
    }
  }
  return { ok: true, rates }
}

// Sincronización COMPLETA de un canal: habitaciones (ficha) → reservas (API) →
// disponibilidad/tarifas → iCal (fechas, si hay URL). Devuelve el resumen.
async function syncChannel(accId, channelId) {
  let channel = await getChannel(accId, channelId)
  if (!channel) throw new Error('Canal no encontrado')
  const summary = {}
  // 1) Habitaciones (crea el mapeo) — primero para mapear reservas.
  summary.rooms = await syncRoomTypes(accId, channel).catch(e => ({ ok: false, error: e.message }))
  channel = await getChannel(accId, channelId) // recarga el mapeo recién guardado
  // 2) Reservas por API.
  summary.reservations = await syncReservations(accId, channel).catch(e => ({ ok: false, error: e.message }))
  // 3) Disponibilidad/tarifas.
  summary.availability = await syncAvailability(accId, channel).catch(e => ({ ok: false, error: e.message }))
  // 4) iCal (fechas) si hay URL configurada.
  if (channel.config?.icalImportUrl) summary.ical = await importIcal(accId, channel).catch(e => ({ ok: false, error: e.message }))
  const ok = Object.values(summary).every(s => s?.ok !== false)
  await pool.query('UPDATE hotel_channels SET last_sync=?, last_result=? WHERE id=?', [Date.now(), JSON.stringify(summary).slice(0, 1000), channelId]).catch(() => {})
  return { ok, ...summary }
}

// Sincroniza todos los canales habilitados (lo llama el worker).
async function syncAll() {
  try {
    const [rows] = await pool.query('SELECT id, account_id FROM hotel_channels WHERE enabled=1')
    for (const r of rows) {
      try { await syncChannel(r.account_id, r.id) }
      catch (e) { console.warn('[channels sync]', r.id, e.message) }
    }
  } catch (e) { console.warn('[channels syncAll]', e.message) }
}

async function importRoomsById(accId, channelId) {
  const c = await getChannel(accId, channelId)
  if (!c) throw new Error('Canal no encontrado')
  return syncRoomTypes(accId, c)
}

module.exports = {
  PROVIDERS, listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  buildIcal, parseIcal, importIcal, inboundReservation,
  providerSchemas, testConnection, syncRoomTypes, syncReservations, syncAvailability, syncChannel, syncAll, importRoomsById,
}
