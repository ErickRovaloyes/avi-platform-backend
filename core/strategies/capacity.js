'use strict'
/**
 * CapacityStrategy — disponibilidad por CAPACIDAD (restaurantes). No es time-slot:
 * la disponibilidad depende de si existe una mesa (o combinación de mesas
 * "joinable") que acomode al grupo dentro de la ventana de ocupación del turno.
 *
 * Implementa la misma interfaz que TimeSlotStrategy (getDayAvailability,
 * getMonthDays) + isAvailable/allocate para la creación de reservas. Toda la
 * dependencia de datos llega por `ctx` (tables/shifts/allocations) → helpers puros
 * testeables sin BD.
 */

const av = require('../../services/availability') // nowInTz (timezone wall-clock)

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const weekdayKey = (dateStr) => WEEKDAYS[new Date(dateStr + 'T00:00:00Z').getUTCDay()]
const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(n => parseInt(n, 10) || 0); return h * 60 + m }
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const capMin = t => Number(t.cap_min ?? t.capMin ?? 1)
const capMax = t => Number(t.cap_max ?? t.capMax ?? 1)
const isJoin = t => t.joinable !== 0 && t.joinable !== false
function dtToMin(dt) {
  if (dt instanceof Date) return dt.getUTCHours() * 60 + dt.getUTCMinutes()
  const m = String(dt).match(/(\d{2}):(\d{2})/)
  return m ? (+m[1]) * 60 + (+m[2]) : 0
}

// Mesas ocupadas durante la ventana [wStart, wEnd) según asignaciones existentes.
function occupiedTables(allocations, wStart, wEnd) {
  const set = new Set()
  for (const a of allocations || []) {
    const s = dtToMin(a.slot_start ?? a.start)
    const e = dtToMin(a.slot_end ?? a.end)
    if (s < wEnd && e > wStart) set.add(a.resourceId ?? a.resource_id)
  }
  return set
}

// Asigna mesa(s) para `party`. Prefiere una sola con el menor desperdicio; si no,
// combina mesas "joinable" del mismo área (greedy). Devuelve {tableIds,totalCap} | null.
function assignTables(tables, party, occupied) {
  const free = (tables || []).filter(t => (t.status || 'active') !== 'inactive' && !occupied.has(t.id))
  // 1) Mesa única que acomode al grupo: preferir que no infrautilice (capMin<=party) y menor capMax.
  const singles = free.filter(t => capMax(t) >= party).sort((a, b) => {
    const afit = capMin(a) <= party ? 0 : 1
    const bfit = capMin(b) <= party ? 0 : 1
    return afit - bfit || capMax(a) - capMax(b)
  })
  if (singles.length) return { tableIds: [singles[0].id], totalCap: capMax(singles[0]) }
  // 2) Combinación de mesas unibles del mismo área (mayor a menor hasta cubrir).
  const byArea = {}
  for (const t of free) if (isJoin(t)) (byArea[t.area || 'indoor'] || (byArea[t.area || 'indoor'] = [])).push(t)
  for (const area of Object.keys(byArea)) {
    const cand = byArea[area].sort((a, b) => capMax(b) - capMax(a))
    let sum = 0; const ids = []
    for (const t of cand) { ids.push(t.id); sum += capMax(t); if (sum >= party) return { tableIds: ids, totalCap: sum } }
  }
  return null
}

// Slots candidatos de un día según los turnos (cada slot_every_min) con su ventana
// de ocupación. La última entrada deja entrar mientras quede 1 paso antes del cierre.
function candidateSlots(shifts, dateStr) {
  const wk = weekdayKey(dateStr)
  const out = []
  for (const sh of shifts || []) {
    const days = sh.days
    if (Array.isArray(days) && days.length && !days.includes(wk)) continue
    const start = toMin(sh.start_time ?? sh.startTime)
    const end = toMin(sh.end_time ?? sh.endTime)
    const step = Math.max(5, Number(sh.slot_every_min ?? sh.slotEveryMin) || 15)
    const occ = Math.max(15, Number(sh.avg_occupancy_min ?? sh.avgOccupancyMin) || 90)
    for (let t = start; t <= end - step; t += step) {
      out.push({ time: toHHMM(t), tmin: t, wStart: t, wEnd: t + occ, shiftId: sh.id, occ })
    }
  }
  const seen = new Set()
  return out.filter(s => (seen.has(s.time) ? false : (seen.add(s.time), true))).sort((a, b) => a.tmin - b.tmin)
}

// Ventana para una hora arbitraria (no necesariamente en la grilla): turno que la cubre.
function windowForTime(shifts, dateStr, time) {
  const grid = candidateSlots(shifts, dateStr).find(s => s.time === time)
  if (grid) return grid
  const wk = weekdayKey(dateStr)
  const tmin = toMin(time)
  for (const sh of shifts || []) {
    const days = sh.days
    if (Array.isArray(days) && days.length && !days.includes(wk)) continue
    if (tmin >= toMin(sh.start_time ?? sh.startTime) && tmin < toMin(sh.end_time ?? sh.endTime)) {
      const occ = Math.max(15, Number(sh.avg_occupancy_min ?? sh.avgOccupancyMin) || 90)
      return { time, tmin, wStart: tmin, wEnd: tmin + occ, shiftId: sh.id, occ }
    }
  }
  return null
}

// Horas con mesa disponible para `party` (string[]).
function availableTimes({ tables, shifts, allocations, party, dateStr, tz, minAdvanceMin = 0 }) {
  const now = av.nowInTz(tz)
  const dayOffset = Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(now.date + 'T00:00:00Z')) / 86400000)
  if (dayOffset < 0) return []
  const out = []
  for (const c of candidateSlots(shifts, dateStr)) {
    if ((dayOffset * 1440 + (c.tmin - now.minutes)) < minAdvanceMin) continue
    if (assignTables(tables, party, occupiedTables(allocations, c.wStart, c.wEnd))) out.push(c.time)
  }
  return [...new Set(out)].sort()
}

const partyOf = (p) => Math.max(1, Number(p) || 2)

module.exports = {
  id: 'capacity',
  // Helpers puros expuestos para tests y para los nodos de IA.
  _internals: { assignTables, candidateSlots, occupiedTables, windowForTime, availableTimes },

  async getDayAvailability(calendar, dateStr, { partySize, ctx } = {}) {
    const [tables, shifts, allocations] = await Promise.all([
      ctx.getTables(calendar.accountId, calendar.id),
      ctx.getShifts(calendar.accountId, calendar.id),
      ctx.getDateAllocations(calendar.accountId, calendar.id, dateStr),
    ])
    return availableTimes({
      tables, shifts, allocations, party: partyOf(partySize), dateStr,
      tz: calendar.timezone, minAdvanceMin: Number(calendar.appointment?.minAdvanceMin) || 0,
    })
  },

  async getMonthDays(calendar, { year, month, ctx } = {}) {
    const shifts = await ctx.getShifts(calendar.accountId, calendar.id)
    const y = Number(year), m = Number(month), mm = String(m).padStart(2, '0')
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const now = av.nowInTz(calendar.timezone)
    const maxAdv = calendar.appointment?.maxAdvanceDays != null ? Number(calendar.appointment.maxAdvanceDays) : 60
    const days = []
    for (let d = 1; d <= lastDay; d++) {
      const ds = `${y}-${mm}-${String(d).padStart(2, '0')}`
      const off = Math.round((Date.parse(ds + 'T00:00:00Z') - Date.parse(now.date + 'T00:00:00Z')) / 86400000)
      if (off < 0 || (maxAdv >= 0 && off > maxAdv)) continue
      if (candidateSlots(shifts, ds).length > 0) days.push(ds)
    }
    return { year: y, month: m, days }
  },

  // ¿Existe asignación posible para crear la reserva?
  async isAvailable(calendar, { date, time, partySize, ctx } = {}) {
    const [tables, shifts, allocations] = await Promise.all([
      ctx.getTables(calendar.accountId, calendar.id),
      ctx.getShifts(calendar.accountId, calendar.id),
      ctx.getDateAllocations(calendar.accountId, calendar.id, date),
    ])
    const c = windowForTime(shifts, date, time)
    if (!c) return false
    return !!assignTables(tables, partyOf(partySize), occupiedTables(allocations, c.wStart, c.wEnd))
  },

  // Asigna y persiste mesa(s). Devuelve { tableIds, windowMin } | null.
  async allocate(calendar, bookingId, { date, time, partySize, ctx } = {}) {
    const [tables, shifts, allocations] = await Promise.all([
      ctx.getTables(calendar.accountId, calendar.id),
      ctx.getShifts(calendar.accountId, calendar.id),
      ctx.getDateAllocations(calendar.accountId, calendar.id, date),
    ])
    const c = windowForTime(shifts, date, time)
    if (!c) return null
    const plan = assignTables(tables, partyOf(partySize), occupiedTables(allocations, c.wStart, c.wEnd))
    if (!plan) return null
    await ctx.insertAllocations(calendar.accountId, bookingId, calendar.id, date, c, plan.tableIds)
    return { tableIds: plan.tableIds, windowMin: c.occ }
  },
}
