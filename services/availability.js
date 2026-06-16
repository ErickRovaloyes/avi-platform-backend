'use strict'
/**
 * Motor de disponibilidad — calcula los horarios libres de un calendario para
 * una fecha dada, considerando:
 *   - Disponibilidad semanal por día (múltiples franjas).
 *   - Excepciones (bloquear día, horario custom para una fecha).
 *   - Reservas existentes (+ buffer entre citas).
 *   - Config de citas: duración, buffer, máximo por día, antelación mín/máx,
 *     reservas simultáneas (capacidad).
 *
 * Funciones puras (sin DB). La capa de datos (services/bookings.js) le pasa el
 * calendario y las reservas ya cargadas.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function toMin(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(n => parseInt(n, 10) || 0)
  return h * 60 + m
}
function toHHMM(min) {
  const h = Math.floor(min / 60), m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Componentes de "ahora" en la zona horaria del calendario (wall-clock).
function nowInTz(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date())
    const o = {}
    parts.forEach(p => { o[p.type] = p.value })
    return { date: `${o.year}-${o.month}-${o.day}`, minutes: parseInt(o.hour) * 60 + parseInt(o.minute) }
  } catch {
    const d = new Date()
    return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }
  }
}

function diffDays(fromDate, toDate) {
  return Math.round((Date.parse(toDate + 'T00:00:00Z') - Date.parse(fromDate + 'T00:00:00Z')) / 86400000)
}

function weekdayKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  return WEEKDAYS[d.getUTCDay()]
}

// Ventanas de trabajo de una fecha: respeta excepciones, si no, la semana.
function windowsForDate(calendar, dateStr) {
  const exceptions = Array.isArray(calendar.exceptions) ? calendar.exceptions : []
  const exc = exceptions.find(e => e && e.date === dateStr)
  if (exc) {
    if (exc.type === 'block') return []
    if (exc.type === 'custom') return (exc.slots || []).map(s => ({ start: toMin(s.start), end: toMin(s.end) }))
  }
  const av = calendar.availability || {}
  const day = av[weekdayKey(dateStr)]
  if (!day || day.enabled === false) return []
  return (day.slots || []).map(s => ({ start: toMin(s.start), end: toMin(s.end) }))
}

// Slots candidatos (antes de filtrar por antelación/reservas). Cada uno lleva su
// propia duración. Soporta:
//   - excepción type 'block'  → ninguno
//   - excepción type 'slots'  → LISTA EXPLÍCITA de slots individuales {start,duration,blocked}
//   - excepción type 'custom' → rangos especiales → se generan por duración
//   - sin excepción           → horario semanal del día → se generan por duración
function generateCandidates(calendar, dateStr, durationMin) {
  const ap = calendar.appointment || {}
  const defDur = Number(durationMin) || Number(ap.defaultDuration) || 30
  const buffer = Number(ap.buffer) || 0
  const exceptions = Array.isArray(calendar.exceptions) ? calendar.exceptions : []
  const exc = exceptions.find(e => e && e.date === dateStr)

  if (exc?.type === 'block') return []
  if (exc?.type === 'slots') {
    return (exc.slots || [])
      .filter(sl => sl && !sl.blocked && (sl.start || sl.time))
      .map(sl => ({ start: toMin(sl.start || sl.time), duration: Number(sl.duration) || defDur }))
  }

  let windows
  if (exc?.type === 'custom') windows = (exc.slots || []).map(s => ({ start: toMin(s.start), end: toMin(s.end) }))
  else {
    const day = (calendar.availability || {})[weekdayKey(dateStr)]
    if (!day || day.enabled === false) return []
    windows = (day.slots || []).map(s => ({ start: toMin(s.start), end: toMin(s.end) }))
  }
  const step = defDur + buffer
  const out = []
  for (const w of windows) for (let t = w.start; t + defDur <= w.end; t += step) out.push({ start: t, duration: defDur })
  return out
}

/**
 * Devuelve los slots disponibles para una fecha.
 * @returns string[] — horas "HH:MM"
 */
function computeSlots(calendar, dateStr, bookings = [], { durationMin } = {}) {
  const ap = calendar.appointment || {}
  const defDur = Number(durationMin) || Number(ap.defaultDuration) || 30
  const buffer = Number(ap.buffer) || 0
  const maxPerDay = Number(ap.maxPerDay) || 0
  const minAdvance = Number(ap.minAdvanceMin) || 0
  const maxAdvanceDays = ap.maxAdvanceDays != null ? Number(ap.maxAdvanceDays) : 60
  const capacity = ap.allowSimultaneous ? Math.max(1, Number(ap.capacity) || 1) : 1

  if (calendar.status === 'inactive') return []

  const active = bookings.filter(b => b.date === dateStr && !['cancelled', 'noshow'].includes(b.status))
  if (maxPerDay > 0 && active.length >= maxPerDay) return []

  const now = nowInTz(calendar.timezone)
  const dayOffset = diffDays(now.date, dateStr)
  if (dayOffset < 0) return []
  if (maxAdvanceDays >= 0 && dayOffset > maxAdvanceDays) return []

  const candidates = generateCandidates(calendar, dateStr, durationMin)
  const busy = active.map(b => {
    const s = toMin(b.time); const dur = Number(b.duration) || defDur
    return { start: s - buffer, end: s + dur + buffer }
  })

  const slots = []
  for (const c of candidates) {
    const absFromNow = dayOffset * 1440 + (c.start - now.minutes)
    if (absFromNow < minAdvance) continue
    const overlap = busy.filter(b => c.start < b.end && (c.start + c.duration) > b.start).length
    if (overlap >= capacity) continue
    slots.push(toHHMM(c.start))
  }
  return [...new Set(slots)].sort()
}

// ¿Está libre un slot concreto? (para validar al crear/reagendar)
function isSlotAvailable(calendar, dateStr, timeStr, bookings = [], { durationMin, ignoreBookingId } = {}) {
  const filtered = (bookings || []).filter(b => b.id !== ignoreBookingId)
  const slots = computeSlots(calendar, dateStr, filtered, { durationMin })
  return slots.includes(timeStr)
}

module.exports = { computeSlots, isSlotAvailable, generateCandidates, windowsForDate, nowInTz, WEEKDAYS }
