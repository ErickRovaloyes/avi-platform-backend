'use strict'
const pms = require('../services/pms')
const providers = require('../services/pmsProviders')

// GET config (autenticado). El token se enmascara; hasToken indica si existe.
const getConfig = async (req, res) => {
  try {
    const cfg = await pms.loadConfig(req.params.accId) || {}
    res.json({
      ...pms.publicConfig(cfg),
      baseUrl: cfg.baseUrl || '',
      notifyTeam: cfg.notifyTeam !== false,
      postBookingFlowId: cfg.postBookingFlowId || '',
      hasToken: !!cfg.token,
      providers: providers.listProviders(),
    })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

// Guarda la configuración. El token solo se actualiza si llega uno nuevo no vacío.
const saveConfig = async (req, res) => {
  const { accId } = req.params
  const { provider, token, baseUrl, currency, maxPhotos, notifyTeam, postBookingFlowId } = req.body || {}
  try {
    const cur = await pms.loadConfig(accId) || {}
    const next = { ...cur }
    if (provider !== undefined) {
      if (provider && !providers.getProvider(provider)) return res.status(400).json({ error: 'Proveedor desconocido' })
      next.provider = provider || ''
    }
    if (token !== undefined && token !== '' && !String(token).includes('•')) next.token = String(token).trim()
    if (baseUrl !== undefined) next.baseUrl = String(baseUrl || '').trim()
    if (currency !== undefined) next.currency = String(currency || 'COP').toUpperCase().slice(0, 6)
    if (maxPhotos !== undefined) next.maxPhotos = Math.max(1, Math.min(10, Number(maxPhotos) || 4))
    if (notifyTeam !== undefined) next.notifyTeam = !!notifyTeam
    if (postBookingFlowId !== undefined) next.postBookingFlowId = String(postBookingFlowId || '')
    await pms.saveConfig(accId, next)
    res.json({ ok: true, config: { ...pms.publicConfig(next), hasToken: !!next.token } })
  } catch (e) { console.error('[pms saveConfig]', e); res.status(500).json({ error: 'Error interno' }) }
}

// Prueba la conexión con la config GUARDADA.
const test = async (req, res) => {
  try { res.json(await pms.testConnection(req.params.accId)) }
  catch (e) { res.status(502).json({ ok: false, message: e.message }) }
}

// Rate limiter en memoria para el proxy PÚBLICO (frena la enumeración de códigos
// de reserva por IP). Ventana deslizante de 60s.
const _rate = new Map() // key ip → [timestamps]
function tooMany(ip) {
  const now = Date.now(), win = 60000, max = 40
  const arr = (_rate.get(ip) || []).filter(t => now - t < win)
  arr.push(now)
  _rate.set(ip, arr)
  if (_rate.size > 5000) { for (const [k, v] of _rate) { if (!v.some(t => now - t < win)) _rate.delete(k) } }
  return arr.length > max
}

// Proxy del asistente (webchat-en-navegador; el motor del servidor llama al servicio directo).
const tool = async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'ip'
  if (tooMany(ip)) return res.status(429).json({ error: 'Demasiadas solicitudes, intenta en un momento.' })
  try {
    const { fn, args, convId, agId } = req.body || {}
    const r = await pms.toolCall(req.params.accId, fn, args || {}, { convId, agId })
    // No exponer datos crudos del proveedor.
    res.json({ text: r.text, media: r.media || [], booked: !!r.booked, bookingCode: r.bookingCode || '' })
  } catch (e) { res.status(400).json({ error: e.message }) }
}

module.exports = { getConfig, saveConfig, test, tool }
