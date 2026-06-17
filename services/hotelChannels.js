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

// ── Adaptadores de API por proveedor (pull de reservas) ─────────────────────
// HosRoom / Kunas / Booking exponen APIs propias (requieren credenciales/convenio).
// Aquí el "pull" usa iCal si está configurado; el hook de API queda listo para
// cablear el endpoint real del proveedor cuando haya credenciales.
async function pullReservations(accId, channel) {
  if (channel.config?.icalImportUrl) return importIcal(accId, channel)
  // TODO API real del proveedor (channel.config.apiKey/endpoint). Sin credenciales → no-op.
  return { ok: false, error: `Sin iCal ni API configurada para ${channel.provider}` }
}

async function syncChannel(accId, channelId) {
  const channel = await getChannel(accId, channelId)
  if (!channel) throw new Error('Canal no encontrado')
  const r = await pullReservations(accId, channel)
  await pool.query('UPDATE hotel_channels SET last_sync=?, last_result=? WHERE id=?', [Date.now(), JSON.stringify(r).slice(0, 500), channelId]).catch(() => {})
  return r
}

// Sincroniza todos los canales habilitados (lo llama el worker).
async function syncAll() {
  try {
    const [rows] = await pool.query('SELECT * FROM hotel_channels WHERE enabled=1')
    for (const r of rows) {
      const ch = mapCh(r)
      try { const res = await pullReservations(r.account_id, ch); await pool.query('UPDATE hotel_channels SET last_sync=?, last_result=? WHERE id=?', [Date.now(), JSON.stringify(res).slice(0, 500), ch.id]).catch(() => {}) }
      catch (e) { console.warn('[channels sync]', ch.provider, e.message) }
    }
  } catch (e) { console.warn('[channels syncAll]', e.message) }
}

module.exports = {
  PROVIDERS, listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  buildIcal, parseIcal, importIcal, inboundReservation, syncChannel, syncAll,
}
