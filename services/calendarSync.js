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
const ms = require('./outlook')

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

// Rellena una plantilla con los datos de la reserva. Placeholders soportados:
// {cliente} {servicio} {calendario} {fecha} {hora} {telefono} {email} {duracion}
// {notas} {id}. Si una plantilla está vacía, el llamador usa el valor por defecto.
function fillTemplate(tpl, calendar, booking) {
  const map = {
    cliente: booking.clientName || '', servicio: calendar.name || '', calendario: calendar.name || '',
    fecha: booking.date || '', hora: booking.time || '', telefono: booking.clientPhone || '',
    email: booking.clientEmail || '', duracion: String(booking.duration || ''), notas: booking.notes || '', id: booking.id || '',
  }
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (map[k] != null ? map[k] : `{${k}}`))
}

function buildEvent(calendar, booking) {
  const tz = calendar.timezone || 'UTC'
  const gi = calendar.integrations?.google || {}
  const [h, m] = String(booking.time || '00:00').split(':').map(Number)
  const startMins = (h || 0) * 60 + (m || 0)
  const endMins = startMins + (Number(booking.duration) || 30)
  let endDate = booking.date
  if (endMins >= 1440) endDate = new Date(Date.parse(booking.date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  const eMin = endMins % 1440

  // Título y descripción personalizables por calendario (con plantillas).
  const summary = (gi.eventTitle && gi.eventTitle.trim())
    ? fillTemplate(gi.eventTitle, calendar, booking)
    : `${calendar.name || 'Reserva'} — ${booking.clientName || 'Cliente'}`
  const description = (gi.eventDescription && gi.eventDescription.trim())
    ? fillTemplate(gi.eventDescription, calendar, booking)
    : `Reserva ${booking.id}\nCliente: ${booking.clientName || ''}\nTel: ${booking.clientPhone || ''}\nEmail: ${booking.clientEmail || ''}${booking.notes ? `\nNotas: ${booking.notes}` : ''}`

  const event = {
    summary,
    description,
    start: { dateTime: `${booking.date}T${booking.time}:00`, timeZone: tz },
    end: { dateTime: `${endDate}T${pad(Math.floor(eMin / 60))}:${pad(eMin % 60)}:00`, timeZone: tz },
  }
  if (gi.location && gi.location.trim()) event.location = fillTemplate(gi.location, calendar, booking)
  if (gi.colorId) event.colorId = String(gi.colorId)
  // Invitar al cliente como asistente (recibe la invitación en su correo).
  if (gi.addGuest && booking.clientEmail && /@/.test(booking.clientEmail)) {
    event.attendees = [{ email: booking.clientEmail, displayName: booking.clientName || undefined }]
  }
  return event
}

// Evento en formato Microsoft Graph.
function buildGraphEvent(calendar, booking) {
  const e = buildEvent(calendar, booking)
  return {
    subject: e.summary,
    body: { contentType: 'text', content: e.description },
    start: { dateTime: e.start.dateTime, timeZone: e.start.timeZone },
    end: { dateTime: e.end.dateTime, timeZone: e.end.timeZone },
  }
}

// Push a Outlook (persiste el eventId en meta.outlookEventId). Best-effort.
async function pushOutlook(accId, calendar, booking, action) {
  try {
    const oi = calendar.integrations?.outlook
    if (!oi?.enabled) return
    const token = await ms.getValidAccessToken(calendar)
    if (!token) return
    const calId = oi.calendarId || 'primary'
    const existingId = booking.meta?.outlookEventId
    if (action === 'delete') { if (existingId) await ms.deleteEvent(token, existingId); return }
    const event = buildGraphEvent(calendar, booking)
    if (action === 'update' && existingId) { await ms.updateEvent(token, existingId, event); return }
    const r = await ms.createEvent(token, calId, event)
    if (r?.id) {
      const newMeta = { ...(booking.meta || {}), outlookEventId: r.id }
      await pool.query('UPDATE calendar_bookings SET meta=? WHERE id=? AND account_id=?', [JSON.stringify(newMeta), booking.id, accId]).catch(() => {})
    }
  } catch (e) { console.warn('[calendarSync outlook]', action, e.message) }
}

// Guarda el resultado de la sincronización en la reserva (meta.googleSync) para
// poder DIAGNOSTICAR por qué un evento no se creó (visible en la ficha de la reserva).
async function setSyncMeta(accId, booking, val) {
  try {
    const meta = { ...(booking.meta || {}), googleSync: { ...val, at: Date.now() } }
    await pool.query('UPDATE calendar_bookings SET meta=? WHERE id=? AND account_id=?', [JSON.stringify(meta), booking.id, accId])
  } catch { /* non-critical */ }
}

// Crea/actualiza/borra el evento en Google (+ Outlook). Devuelve el eventId de
// Google (o null) — el llamador lo guarda en external_id (back-compat).
async function pushBooking(accId, calendar, booking, action) {
  // Outlook en paralelo (no bloquea ni afecta el retorno de Google).
  pushOutlook(accId, calendar, booking, action).catch(() => {})
  const gi = calendar.integrations?.google
  if (!gi?.enabled) return null  // sync desactivado para este calendario → no se registra
  const calId = gi.calendarId || 'primary'
  try {
    const token = await g.getValidAccessToken(accId, gi.connectionId)
    if (action === 'delete') { if (booking.externalId) await g.deleteCalendarEvent(token, calId, booking.externalId); await setSyncMeta(accId, booking, { status: 'deleted', calendarId: calId }); return null }
    const event = buildEvent(calendar, booking)
    if (action === 'update' && booking.externalId) { await g.updateCalendarEvent(token, calId, booking.externalId, event); await setSyncMeta(accId, booking, { status: 'ok', eventId: booking.externalId, calendarId: calId }); return booking.externalId }
    const r = await g.createCalendarEvent(token, calId, event)
    await setSyncMeta(accId, booking, { status: 'ok', eventId: r?.id || null, calendarId: calId })
    return r?.id || null
  } catch (e) {
    console.warn('[calendarSync push]', action, e.message)
    await setSyncMeta(accId, booking, { status: 'error', error: e.message, calendarId: calId })
    return null
  }
}

// Intervalos ocupados de Google para una fecha → "reservas" virtuales (bloquean).
async function googleBusyForDate(accId, calendar, dateStr) {
  try {
    const gi = calendar.integrations?.google
    if (!gi?.enabled || !gi.blockBusy) return []
    const calId = gi.calendarId || 'primary'
    const tz = calendar.timezone || 'UTC'
    const token = await g.getValidAccessToken(accId, gi.connectionId)
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

// Intervalos ocupados de Outlook para una fecha → "reservas" virtuales.
async function outlookBusyForDate(accId, calendar, dateStr) {
  try {
    const oi = calendar.integrations?.outlook
    if (!oi?.enabled || !oi.blockBusy || !oi.email) return []
    const tz = calendar.timezone || 'UTC'
    const token = await ms.getValidAccessToken(calendar)
    if (!token) return []
    const dayStart = wallTimeToUtcMs(dateStr, '00:00', tz)
    const busy = await ms.freeBusy(token, oi.email, new Date(dayStart).toISOString(), new Date(dayStart + 86400000).toISOString(), tz)
    const out = []
    for (const b of busy) {
      const s = wallInTz(Date.parse(b.start.endsWith('Z') ? b.start : b.start + 'Z'), tz)
      const e = wallInTz(Date.parse(b.end.endsWith('Z') ? b.end : b.end + 'Z'), tz)
      const startMin = s.date < dateStr ? 0 : s.date > dateStr ? null : s.min
      const endMin = e.date > dateStr ? 1440 : e.date < dateStr ? null : e.min
      if (startMin == null || endMin == null || endMin <= startMin) continue
      out.push({ date: dateStr, time: minToHm(startMin), duration: endMin - startMin, status: 'confirmed', _outlook: true })
    }
    return out
  } catch (e) { console.warn('[calendarSync outlook busy]', e.message); return [] }
}

// Ocupado agregado de TODAS las estrategias de calendario externas (Google + Outlook).
async function busyForDate(accId, calendar, dateStr) {
  const [g, o] = await Promise.all([googleBusyForDate(accId, calendar, dateStr), outlookBusyForDate(accId, calendar, dateStr)])
  return [...g, ...o]
}

module.exports = { pushBooking, googleBusyForDate, outlookBusyForDate, busyForDate }
