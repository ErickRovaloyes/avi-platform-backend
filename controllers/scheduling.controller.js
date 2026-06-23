'use strict'
const sched = require('../services/scheduling')
const bookings = require('../services/bookings')

// GET config (autenticado) — calendarios elegidos + sus descripciones.
const getConfig = async (req, res) => {
  try { res.json(await sched.publicConfig(req.params.accId)) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// Guarda los calendarios que el asistente puede usar para la agenda.
const saveConfig = async (req, res) => {
  const { accId } = req.params
  try {
    const ids = Array.isArray(req.body?.calendarIds) ? req.body.calendarIds.filter(Boolean) : []
    // Valida que pertenezcan a la cuenta y toma la zona horaria del primero.
    const all = await bookings.listCalendars(accId)
    const valid = ids.filter(id => all.some(c => c.id === id))
    const tz = all.find(c => c.id === valid[0])?.timezone || ''
    await sched.saveConfig(accId, { calendarIds: valid, timezone: tz })
    res.json({ ok: true, config: await sched.publicConfig(accId) })
  } catch (e) { console.error('[scheduling saveConfig]', e); res.status(500).json({ error: e.message || 'Error interno' }) }
}

// Proxy público: lo usa el webchat-en-navegador (el motor del servidor llama al
// servicio directamente). No expone datos sensibles.
const tool = async (req, res) => {
  try {
    const { fn, args, convId, agId } = req.body || {}
    res.json(await sched.toolCall(req.params.accId, fn, args || {}, { convId, agId }))
  } catch (e) { res.status(400).json({ error: e.message }) }
}

module.exports = { getConfig, saveConfig, tool }
