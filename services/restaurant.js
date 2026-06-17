'use strict'
/**
 * Servicio de Restaurante (Fase 2) — acceso a datos de mesas, turnos, waitlist y
 * asignaciones. Lo consume la CapacityStrategy (vía ctx) y el controlador REST.
 */

const pool = require('../db')
const { uid, parseJ } = require('../utils')

// ── Mesas ────────────────────────────────────────────────────────────────────
const mapTable = r => r && ({
  id: r.id, accountId: r.account_id, calendarId: r.calendar_id, name: r.name,
  area: r.area || 'indoor', capMin: r.cap_min, capMax: r.cap_max,
  joinable: r.joinable !== 0, sortOrder: r.sort_order || 0, status: r.status || 'active',
})

async function getTables(accId, calId) {
  const [rows] = await pool.query(
    "SELECT * FROM rest_tables WHERE account_id=? AND calendar_id=? AND status<>'inactive' ORDER BY sort_order ASC, name ASC",
    [accId, calId]
  )
  // Devuelve forma "snake" que la estrategia entiende (cap_min/cap_max/joinable/status/id/area).
  return rows.map(r => ({ id: r.id, name: r.name, area: r.area || 'indoor', cap_min: r.cap_min, cap_max: r.cap_max, joinable: r.joinable, status: r.status }))
}
async function listTables(accId, calId) {
  const [rows] = await pool.query('SELECT * FROM rest_tables WHERE account_id=? AND calendar_id=? ORDER BY sort_order ASC, name ASC', [accId, calId])
  return rows.map(mapTable)
}
async function createTable(accId, calId, b = {}) {
  const id = 'tbl_' + uid(); const ts = Date.now()
  await pool.query(
    'INSERT INTO rest_tables (id, account_id, calendar_id, name, area, cap_min, cap_max, joinable, sort_order, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.name || 'Mesa', b.area || 'indoor', Number(b.capMin) || 1, Number(b.capMax) || 2,
     b.joinable === false ? 0 : 1, Number(b.sortOrder) || 0, b.status || 'active', ts, ts]
  )
  const [[r]] = await pool.query('SELECT * FROM rest_tables WHERE id=?', [id])
  return mapTable(r)
}
async function updateTable(accId, tableId, b = {}) {
  const map = { name: 'name', area: 'area', capMin: 'cap_min', capMax: 'cap_max', sortOrder: 'sort_order', status: 'status' }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  if (b.joinable !== undefined) { sets.push('joinable=?'); vals.push(b.joinable ? 1 : 0) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now()); vals.push(tableId, accId)
  await pool.query(`UPDATE rest_tables SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteTable(accId, tableId) {
  await pool.query('DELETE FROM rest_tables WHERE id=? AND account_id=?', [tableId, accId])
}

// ── Turnos ───────────────────────────────────────────────────────────────────
const mapShift = r => r && ({
  id: r.id, accountId: r.account_id, calendarId: r.calendar_id, name: r.name,
  startTime: r.start_time, endTime: r.end_time, avgOccupancyMin: r.avg_occupancy_min,
  slotEveryMin: r.slot_every_min, days: parseJ(r.days, null), sortOrder: r.sort_order || 0,
})

async function getShifts(accId, calId) {
  const [rows] = await pool.query('SELECT * FROM rest_shifts WHERE account_id=? AND calendar_id=? ORDER BY sort_order ASC, start_time ASC', [accId, calId])
  // Forma "snake" para la estrategia.
  return rows.map(r => ({ id: r.id, name: r.name, start_time: r.start_time, end_time: r.end_time, avg_occupancy_min: r.avg_occupancy_min, slot_every_min: r.slot_every_min, days: parseJ(r.days, null) }))
}
async function listShifts(accId, calId) {
  const [rows] = await pool.query('SELECT * FROM rest_shifts WHERE account_id=? AND calendar_id=? ORDER BY sort_order ASC, start_time ASC', [accId, calId])
  return rows.map(mapShift)
}
async function createShift(accId, calId, b = {}) {
  const id = 'sh_' + uid(); const ts = Date.now()
  await pool.query(
    'INSERT INTO rest_shifts (id, account_id, calendar_id, name, start_time, end_time, avg_occupancy_min, slot_every_min, days, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.name || 'Turno', b.startTime || '12:00', b.endTime || '16:00',
     Number(b.avgOccupancyMin) || 90, Number(b.slotEveryMin) || 15,
     b.days ? JSON.stringify(b.days) : null, Number(b.sortOrder) || 0, ts, ts]
  )
  const [[r]] = await pool.query('SELECT * FROM rest_shifts WHERE id=?', [id])
  return mapShift(r)
}
async function updateShift(accId, shiftId, b = {}) {
  const map = { name: 'name', startTime: 'start_time', endTime: 'end_time', avgOccupancyMin: 'avg_occupancy_min', slotEveryMin: 'slot_every_min', sortOrder: 'sort_order' }
  const sets = []; const vals = []
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
  if (b.days !== undefined) { sets.push('days=?'); vals.push(b.days ? JSON.stringify(b.days) : null) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now()); vals.push(shiftId, accId)
  await pool.query(`UPDATE rest_shifts SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
}
async function deleteShift(accId, shiftId) {
  await pool.query('DELETE FROM rest_shifts WHERE id=? AND account_id=?', [shiftId, accId])
}

// ── Asignaciones (booking_allocations) para la estrategia ───────────────────
// Asignaciones de mesas de un día (excluye reservas canceladas / no-show).
async function getDateAllocations(accId, calId, dateStr) {
  const [rows] = await pool.query(
    `SELECT a.resource_id, a.slot_start, a.slot_end
       FROM booking_allocations a
       JOIN calendar_bookings b ON b.id = a.booking_id
      WHERE a.account_id=? AND b.calendar_id=? AND b.date=?
        AND b.status NOT IN ('cancelled','noshow')`,
    [accId, calId, dateStr]
  )
  return rows.map(r => ({ resourceId: r.resource_id, slot_start: r.slot_start, slot_end: r.slot_end }))
}

// Inserta las asignaciones de mesa de una reserva (1 por mesa) con su ventana.
async function insertAllocations(accId, bookingId, calId, dateStr, slot, tableIds) {
  const pad = n => String(n).padStart(2, '0')
  const startHHMM = slot.time
  const endMin = slot.wEnd
  const endHHMM = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`
  const startDt = `${dateStr} ${startHHMM}:00`
  const endDt = `${dateStr} ${endHHMM}:00`
  for (const tableId of tableIds) {
    try {
      await pool.query(
        'INSERT INTO booking_allocations (id, account_id, booking_id, resource_id, unit_key, slot_start, slot_end, qty) VALUES (?,?,?,?,?,?,?,?)',
        ['alloc_' + uid(), accId, bookingId, tableId, `${dateStr}T${startHHMM}`, startDt, endDt, 1]
      )
    } catch (e) { /* misma mesa+hora ya tomada (carrera) — la valida isAvailable */ }
  }
}

// ── Waitlist ─────────────────────────────────────────────────────────────────
const mapWait = r => r && ({
  id: r.id, calendarId: r.calendar_id, date: r.date, time: r.time, shiftId: r.shift_id,
  partySize: r.party_size, customerId: r.customer_id, clientName: r.client_name,
  clientPhone: r.client_phone, status: r.status, notes: r.notes || '', createdAt: r.created_at,
})

async function listWaitlist(accId, calId, { date, status } = {}) {
  const where = ['account_id=?', 'calendar_id=?']; const params = [accId, calId]
  if (date) { where.push('date=?'); params.push(date) }
  if (status) { where.push('status=?'); params.push(status) }
  const [rows] = await pool.query(`SELECT * FROM rest_waitlist WHERE ${where.join(' AND ')} ORDER BY created_at ASC`, params)
  return rows.map(mapWait)
}
async function addWaitlist(accId, calId, b = {}) {
  const id = 'wl_' + uid(); const ts = Date.now()
  await pool.query(
    'INSERT INTO rest_waitlist (id, account_id, calendar_id, date, time, shift_id, party_size, customer_id, client_name, client_phone, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, accId, calId, b.date || '', b.time || '', b.shiftId || null, Number(b.partySize) || 2,
     b.customerId || null, b.clientName || '', b.clientPhone || '', 'waiting', b.notes || '', ts, ts]
  )
  const [[r]] = await pool.query('SELECT * FROM rest_waitlist WHERE id=?', [id])
  return mapWait(r)
}
async function setWaitlistStatus(accId, id, status) {
  await pool.query('UPDATE rest_waitlist SET status=?, updated_at=? WHERE id=? AND account_id=?', [status, Date.now(), id, accId])
  const [[r]] = await pool.query('SELECT * FROM rest_waitlist WHERE id=? AND account_id=?', [id, accId])
  return mapWait(r)
}

module.exports = {
  getTables, listTables, createTable, updateTable, deleteTable,
  getShifts, listShifts, createShift, updateShift, deleteShift,
  getDateAllocations, insertAllocations,
  listWaitlist, addWaitlist, setWaitlistStatus,
}
