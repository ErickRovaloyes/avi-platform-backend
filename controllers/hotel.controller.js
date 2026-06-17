'use strict'
/**
 * Controlador de Hotel (Fase 4a) — config (tipos de habitación + tarifas)
 * autenticada + flujo público de reserva (buscar/cotizar/reservar estadía).
 */

const socket = require('../services/socket')
const hotel = require('../services/hotel')

const touched = (req) => socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId })
const wrap = fn => async (req, res) => { try { await fn(req, res) } catch (e) { res.status(400).json({ error: e.message || 'Error' }) } }

// ── Config (autenticado) ─────────────────────────────────────────────────────
const listRoomTypes = wrap(async (req, res) => res.json(await hotel.listRoomTypes(req.params.accId, req.params.calId, { all: true })))
const createRoomType = wrap(async (req, res) => { const r = await hotel.createRoomType(req.params.accId, req.params.calId, req.body || {}); touched(req); res.json(r) })
const updateRoomType = wrap(async (req, res) => { await hotel.updateRoomType(req.params.accId, req.params.rtId, req.body || {}); touched(req); res.json({ ok: true }) })
const deleteRoomType = wrap(async (req, res) => { await hotel.deleteRoomType(req.params.accId, req.params.rtId); touched(req); res.json({ ok: true }) })

const listRates = wrap(async (req, res) => res.json(await hotel.listRates(req.params.accId, req.params.rtId, req.query || {})))
const setRates = wrap(async (req, res) => { const b = req.body || {}; await hotel.setRateRange(req.params.accId, req.params.rtId, b.from, b.to, b.price); touched(req); res.json({ ok: true }) })
const clearRate = wrap(async (req, res) => { await hotel.clearRate(req.params.accId, req.params.rtId, req.query.date); touched(req); res.json({ ok: true }) })

// ── Público (reserva de estadía) ─────────────────────────────────────────────
const publicSearch = wrap(async (req, res) => {
  const { accId, calId } = req.params
  res.json(await hotel.searchAvailability(accId, calId, { checkin: req.query.checkin, checkout: req.query.checkout, guests: Number(req.query.guests) || 2 }))
})
const publicQuote = wrap(async (req, res) => {
  const { accId, calId } = req.params
  res.json(await hotel.quoteStay(accId, calId, { roomTypeId: req.query.roomTypeId, checkin: req.query.checkin, checkout: req.query.checkout }))
})
const publicBook = wrap(async (req, res) => {
  const { accId, calId } = req.params
  const b = req.body || {}
  const booking = await hotel.bookStay(accId, calId, {
    roomTypeId: b.roomTypeId, checkin: b.checkin, checkout: b.checkout,
    guests: Number(b.guests) || 2, ratePlan: b.ratePlan, client: b.client || {}, channel: 'web',
  })
  socket.emit(accId, 'account:updated', { accId })
  res.json({ ok: true, booking })
})

module.exports = {
  listRoomTypes, createRoomType, updateRoomType, deleteRoomType,
  listRates, setRates, clearRate,
  publicSearch, publicQuote, publicBook,
}
