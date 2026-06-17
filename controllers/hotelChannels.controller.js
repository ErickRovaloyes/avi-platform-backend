'use strict'
/**
 * Controlador de canales / OTAs del hotel. Config autenticada + endpoints
 * públicos: iCal export (.ics que la OTA suscribe) y webhook de reserva entrante
 * (protegido por el secreto del canal).
 */

const socket = require('../services/socket')
const ch = require('../services/hotelChannels')

const touch = (req) => socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId })
const W = fn => async (req, res) => { try { const r = await fn(req, res); if (r !== undefined) res.json(r) } catch (e) { res.status(400).json({ error: e.message || 'Error' }) } }

// ── Config (autenticado) ─────────────────────────────────────────────────────
const list = W(req => ch.listChannels(req.params.accId, req.params.calId))
const create = W(async req => { const c = await ch.createChannel(req.params.accId, req.params.calId, req.body || {}); touch(req); return c })
const update = W(async req => { await ch.updateChannel(req.params.accId, req.params.chanId, req.body || {}); touch(req); return { ok: true } })
const remove = W(async req => { await ch.deleteChannel(req.params.accId, req.params.chanId); touch(req); return { ok: true } })
const sync = W(async req => { const r = await ch.syncChannel(req.params.accId, req.params.chanId); touch(req); return r })
const schemas = W(() => ch.providerSchemas())
const test = W(req => ch.testConnection(req.params.accId, req.params.chanId))
const importRooms = W(async req => { const r = await ch.importRoomsById(req.params.accId, req.params.chanId); touch(req); return r })

// ── Público: iCal export (la OTA se suscribe a esta URL) ─────────────────────
const ical = async (req, res) => {
  try {
    const text = await ch.buildIcal(req.params.accId, req.params.calId, req.params.roomTypeId)
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="avi-${req.params.roomTypeId}.ics"`)
    res.send(text)
  } catch (e) { res.status(400).send('Error') }
}

// ── Público: webhook de reserva entrante (secreto del canal) ─────────────────
const inbound = W(async (req, res) => {
  const { accId, calId, provider } = req.params
  const secret = req.query.secret || req.headers['x-channel-secret']
  // Valida el secreto contra algún canal de ese proveedor en el calendario.
  const channels = await ch.listChannels(accId, calId)
  const match = channels.find(c => c.provider === provider && c.config?.webhookSecret && c.config.webhookSecret === secret)
  if (!match) { res.status(401).json({ error: 'Secreto inválido' }); return undefined }
  const r = await ch.inboundReservation(accId, calId, provider, req.body || {})
  socket.emit(accId, 'account:updated', { accId })
  return { ok: true, ...r }
})

module.exports = { list, create, update, remove, sync, schemas, test, importRooms, ical, inbound }
