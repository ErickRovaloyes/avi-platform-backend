'use strict'
/**
 * Controlador de Restaurante (Fase 2) — CRUD de mesas, turnos y waitlist de un
 * calendario con vertical='restaurant'. La disponibilidad/reserva real va por el
 * motor de reservas (CapacityStrategy).
 */

const socket = require('../services/socket')
const rest = require('../services/restaurant')

const touched = (req) => socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId })

// ── Mesas ────────────────────────────────────────────────────────────────────
const listTables = async (req, res) => {
  try { res.json(await rest.listTables(req.params.accId, req.params.calId)) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const createTable = async (req, res) => {
  try { const t = await rest.createTable(req.params.accId, req.params.calId, req.body || {}); touched(req); res.json(t) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const updateTable = async (req, res) => {
  try { await rest.updateTable(req.params.accId, req.params.tableId, req.body || {}); touched(req); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const deleteTable = async (req, res) => {
  try { await rest.deleteTable(req.params.accId, req.params.tableId); touched(req); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Turnos ───────────────────────────────────────────────────────────────────
const listShifts = async (req, res) => {
  try { res.json(await rest.listShifts(req.params.accId, req.params.calId)) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const createShift = async (req, res) => {
  try { const s = await rest.createShift(req.params.accId, req.params.calId, req.body || {}); touched(req); res.json(s) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const updateShift = async (req, res) => {
  try { await rest.updateShift(req.params.accId, req.params.shiftId, req.body || {}); touched(req); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const deleteShift = async (req, res) => {
  try { await rest.deleteShift(req.params.accId, req.params.shiftId); touched(req); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Waitlist ─────────────────────────────────────────────────────────────────
const listWaitlist = async (req, res) => {
  try { res.json(await rest.listWaitlist(req.params.accId, req.params.calId, { date: req.query.date, status: req.query.status })) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const addWaitlist = async (req, res) => {
  try { const w = await rest.addWaitlist(req.params.accId, req.params.calId, req.body || {}); touched(req); res.json(w) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const updateWaitlist = async (req, res) => {
  const VALID = ['waiting', 'notified', 'seated', 'cancelled', 'expired']
  const status = req.body?.status
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Estado inválido' })
  try { const w = await rest.setWaitlistStatus(req.params.accId, req.params.wid, status); touched(req); res.json(w) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = {
  listTables, createTable, updateTable, deleteTable,
  listShifts, createShift, updateShift, deleteShift,
  listWaitlist, addWaitlist, updateWaitlist,
}
