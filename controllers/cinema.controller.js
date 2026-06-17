'use strict'
/**
 * Controlador de Cine (Fase 3) — config (películas, salas, funciones) autenticada
 * + flujo público de compra (cartelera, mapa de asientos, hold con TTL, compra).
 */

const socket = require('../services/socket')
const cinema = require('../services/cinema')

const touched = (req) => socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId })
const wrap = fn => async (req, res) => { try { await fn(req, res) } catch (e) { res.status(400).json({ error: e.message || 'Error' }) } }

// ── Config (autenticado) ─────────────────────────────────────────────────────
const listMovies = wrap(async (req, res) => res.json(await cinema.listMovies(req.params.accId, req.params.calId)))
const createMovie = wrap(async (req, res) => { const m = await cinema.createMovie(req.params.accId, req.params.calId, req.body || {}); touched(req); res.json(m) })
const updateMovie = wrap(async (req, res) => { await cinema.updateMovie(req.params.accId, req.params.movieId, req.body || {}); touched(req); res.json({ ok: true }) })
const deleteMovie = wrap(async (req, res) => { await cinema.deleteMovie(req.params.accId, req.params.movieId); touched(req); res.json({ ok: true }) })

const listAuditoriums = wrap(async (req, res) => res.json(await cinema.listAuditoriums(req.params.accId, req.params.calId)))
const createAuditorium = wrap(async (req, res) => { const a = await cinema.createAuditorium(req.params.accId, req.params.calId, req.body || {}); touched(req); res.json(a) })
const updateAuditorium = wrap(async (req, res) => { await cinema.updateAuditorium(req.params.accId, req.params.audId, req.body || {}); touched(req); res.json({ ok: true }) })
const deleteAuditorium = wrap(async (req, res) => { await cinema.deleteAuditorium(req.params.accId, req.params.audId); touched(req); res.json({ ok: true }) })

const listShowtimes = wrap(async (req, res) => res.json(await cinema.listShowtimes(req.params.accId, req.params.calId, req.query || {})))
const createShowtime = wrap(async (req, res) => { const s = await cinema.createShowtime(req.params.accId, req.params.calId, req.body || {}); touched(req); res.json(s) })
const updateShowtime = wrap(async (req, res) => { await cinema.updateShowtime(req.params.accId, req.params.showId, req.body || {}); touched(req); res.json({ ok: true }) })
const deleteShowtime = wrap(async (req, res) => { await cinema.deleteShowtime(req.params.accId, req.params.showId); touched(req); res.json({ ok: true }) })

// ── Público (compra) ─────────────────────────────────────────────────────────
// Cartelera: películas + sus funciones (opcional ?date=)
const publicListing = wrap(async (req, res) => {
  const { accId, calId } = req.params
  const [movies, shows] = await Promise.all([
    cinema.listMovies(accId, calId),
    cinema.listShowtimes(accId, calId, { date: req.query.date, from: req.query.from, to: req.query.to }),
  ])
  res.json({ movies, showtimes: shows })
})
const publicSeatMap = wrap(async (req, res) => res.json(await cinema.getSeatMap(req.params.accId, req.params.showId)))
const publicHold = wrap(async (req, res) => {
  const { accId, showId } = req.params
  const r = await cinema.holdSeats(accId, showId, req.body?.seats || [], { sessionId: req.body?.sessionId, ttlMin: req.body?.ttlMin })
  if (!r.ok) return res.status(409).json(r)
  res.json(r)
})
const publicRelease = wrap(async (req, res) => { await cinema.releaseHold(req.params.accId, req.params.showId, req.body?.seats || [], req.body?.sessionId); res.json({ ok: true }) })
const publicBook = wrap(async (req, res) => {
  const { accId, showId } = req.params
  const b = req.body || {}
  const booking = await cinema.bookSeats(accId, showId, b.seats || [], b.client || {}, { sessionId: b.sessionId, channel: 'web' })
  socket.emit(accId, 'account:updated', { accId })
  res.json({ ok: true, booking })
})

module.exports = {
  listMovies, createMovie, updateMovie, deleteMovie,
  listAuditoriums, createAuditorium, updateAuditorium, deleteAuditorium,
  listShowtimes, createShowtime, updateShowtime, deleteShowtime,
  publicListing, publicSeatMap, publicHold, publicRelease, publicBook,
}
