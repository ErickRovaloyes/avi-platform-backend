'use strict'
/**
 * Controlador del PMS operativo del hotel (Fases 4b-4e). Todo autenticado
 * (front-office / staff): recepción, housekeeping, mantenimiento, folios, reportes.
 */

const socket = require('../services/socket')
const pms = require('../services/hotelPms')

const touch = (req) => socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId })
const W = fn => async (req, res) => { try { const r = await fn(req, res); if (r !== undefined) res.json(r) } catch (e) { res.status(400).json({ error: e.message || 'Error' }) } }

// Rooms
const listRooms = W(req => pms.listRooms(req.params.accId, req.params.calId))
const createRoom = W(async req => { const r = await pms.createRoom(req.params.accId, req.params.calId, req.body || {}); touch(req); return r })
const updateRoom = W(async req => { await pms.updateRoom(req.params.accId, req.params.roomId, req.body || {}); touch(req); return { ok: true } })
const deleteRoom = W(async req => { await pms.deleteRoom(req.params.accId, req.params.roomId); touch(req); return { ok: true } })
const setRoomHk = W(async req => { await pms.setRoomHk(req.params.accId, req.params.roomId, req.body?.hkStatus); touch(req); return { ok: true } })

// Recepción
const arrivals = W(req => pms.listArrivals(req.params.accId, req.params.calId, req.query.date || new Date().toISOString().slice(0, 10)))
const departures = W(req => pms.listDepartures(req.params.accId, req.params.calId, req.query.date || new Date().toISOString().slice(0, 10)))
const inHouse = W(req => pms.listInHouse(req.params.accId, req.params.calId))
const checkIn = W(async req => { const r = await pms.checkIn(req.params.accId, req.params.bookingId, req.body?.roomId); touch(req); return r })
const checkOut = W(async req => { const r = await pms.checkOut(req.params.accId, req.params.bookingId); touch(req); return r })
const changeRoom = W(async req => { const r = await pms.changeRoom(req.params.accId, req.params.bookingId, req.body?.roomId); touch(req); return r })
const walkIn = W(async req => { const r = await pms.walkIn(req.params.accId, req.params.calId, req.body || {}); touch(req); return r })

// Housekeeping
const listHk = W(req => pms.listHkTasks(req.params.accId, req.params.calId, req.query || {}))
const createHk = W(async req => { const r = await pms.createHkTask(req.params.accId, req.params.calId, req.body || {}); touch(req); return r })
const updateHk = W(async req => { await pms.updateHkTask(req.params.accId, req.params.taskId, req.body || {}); touch(req); return { ok: true } })

// Mantenimiento
const listMnt = W(req => pms.listMaintenance(req.params.accId, req.params.calId, req.query || {}))
const createMnt = W(async req => { const r = await pms.createMaintenance(req.params.accId, req.params.calId, req.body || {}); touch(req); return r })
const resolveMnt = W(async req => { await pms.resolveMaintenance(req.params.accId, req.params.mntId); touch(req); return { ok: true } })

// Folios
const getFolio = W(req => pms.getFolio(req.params.accId, req.params.bookingId))
const addCharge = W(async req => { const r = await pms.addCharge(req.params.accId, req.params.bookingId, req.body || {}); touch(req); return r })
const addPayment = W(async req => { const r = await pms.addPayment(req.params.accId, req.params.bookingId, req.body || {}); touch(req); return r })

// Reportes
const report = W(req => pms.reportKpis(req.params.accId, req.params.calId, { from: req.query.from, to: req.query.to }))

module.exports = {
  listRooms, createRoom, updateRoom, deleteRoom, setRoomHk,
  arrivals, departures, inHouse, checkIn, checkOut, changeRoom, walkIn,
  listHk, createHk, updateHk, listMnt, createMnt, resolveMnt,
  getFolio, addCharge, addPayment, report,
}
