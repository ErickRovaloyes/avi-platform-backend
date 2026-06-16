'use strict'
/**
 * Sincronización con Google Calendar (push + bloqueo por freeBusy).
 *   - Al crear/reagendar/cancelar una reserva → crea/actualiza/borra el evento en
 *     el Google Calendar elegido (calendar.integrations.google.calendarId).
 *   - Para la disponibilidad: si blockBusy está activo, los eventos ocupados de
 *     Google se convierten en "reservas" virtuales que bloquean los slots.
 * Reutiliza el OAuth de Google de la cuenta (scope de Calendar). Best-effort: si
 * Google no está conectado o falla, no rompe la reserva.
 */

const pool = require('../db')
const g = require('./google')

function pad(n) { return String(n).padStart(2, '0') }
function minToHm(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}` }

// UTC ms del instante (fecha+hora wall-clock) en una zona horaria.
function wallTimeToUtcMs(dateStr, timeStr, tz) {
  const naive = Date.parse(`${dateStr}T${(timeStr || '00:00')}:00Z`)
  if (Number.isNaN(naive)) return NaN
  try {
    const o = {}
    new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(new Date(naive)).forEach(p => { o[p.type] = p.value })
    const asUTC = Date.parse(`${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}Z`)
    return naive - (asUTC - naive)
  } catch { return naive }
}
// Fecha/minuto-del-día (wall-clock) de un instante UTC en una zona horaria.
function wallInTz(utcMs, tz) {
  const o = {}
  new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(utcMs)).forEach(p => { o[p.type] = p.value })
  return { date: `${o.year}-${o.month}-${o.day}`, min: parseInt(o.hour) * 60 + parseInt(o.minute) }
}

function buildEvent(calendar, booking) {
  const tz = calendar.timezone || 'UTC'
  const [h, m] = String(booking.time || '00:00').split(':').map(Number)
  const startMins = (h || 0) * 60 + (m || 0)
  const endMins = startMins + (Number(booking.duration) || 30)
  let endDate = booking.date
  if (endMins >= 1440) endDate = new Date(Date.parse(booking.date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  const eMin = endMins % 1440
  return {
    summary: `${calendar.name || 'Reserva'} — ${booking.clientName || 'Cliente'}`,
    description: `Reserva ${booking.id}\nCliente: ${booking.clientName || ''}\nTel: ${booking.clientPhone || ''}\nEmail: ${booking.clientEmail || ''}`,
    start: { dateTime: `${booking.date}T${booking.time}:00`, timeZone: tz },
    end: { dateTime: `${endDate}T${pad(Math.floor(eMin / 60))}:${pad(eMin % 60)}:00`, timeZone: tz },
  }
}

// Crea/actualiza/borra el evento en Google. Devuelve el eventId (o null).
async function pushBooking(accId, calendar, booking, action) {
  try {
    const gi = calendar.integrations?.google
    if (!gi?.enabled) return null
    const calId = gi.calendarId || 'primary'
    const token = await g.getValidAccessToken(accId)
    if (action === 'delete') { if (booking.externalId) await g.deleteCalendarEvent(token, calId, booking.externalId); return null }
    const event = buildEvent(calendar, booking)
    if (action === 'update' && booking.externalId) { await g.updateCalendarEvent(token, calId, booking.externalId, event); return booking.externalId }
    const r = await g.createCalendarEvent(token, calId, event)
    return r?.id || null
  } catch (e) { console.warn('[calendarSync push]', action, e.message); return null }
}

// Intervalos ocupados de Google para una fecha → "reservas" virtuales (bloquean).
async function googleBusyForDate(accId, calendar, dateStr) {
  try {
    const gi = calendar.integrations?.google
    if (!gi?.enabled || !gi.blockBusy) return []
    const calId = gi.calendarId || 'primary'
    const tz = calendar.timezone || 'UTC'
    const token = await g.getValidAccessToken(accId)
    const dayStart = wallTimeToUtcMs(dateStr, '00:00', tz)
    const busy = await g.freeBusy(token, calId, new Date(dayStart).toISOString(), new Date(dayStart + 86400000).toISOString())
    const out = []
    for (const b of busy) {
      const s = wallInTz(Date.parse(b.start), tz)
      const e = wallInTz(Date.parse(b.end), tz)
      const startMin = s.date < dateStr ? 0 : s.date > dateStr ? null : s.min
      const endMin = e.date > dateStr ? 1440 : e.date < dateStr ? null : e.min
      if (startMin == null || endMin == null || endMin <= startMin) continue
      out.push({ date: dateStr, time: minToHm(startMin), duration: endMin - startMin, status: 'confirmed', _google: true })
    }
    return out
  } catch (e) { console.warn('[calendarSync busy]', e.message); return [] }
}

module.exports = { pushBooking, googleBusyForDate }
