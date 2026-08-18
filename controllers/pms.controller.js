'use strict'
const pms = require('../services/pms')
const providers = require('../services/pmsProviders')
const pool = require('../db')

/**
 * Las integraciones de PMS que la cuenta desbloqueo instalando su herramienta del catalogo.
 * Sin fila en `ai_tools`, el proveedor ni siquiera aparece en el selector.
 */
async function integracionesDe(accId) {
  try {
    const [filas] = await pool.query(
      'SELECT handler_key FROM ai_tools WHERE account_id=? AND handler_key IS NOT NULL', [accId]
    )
    return filas.map(f => f.handler_key).filter(Boolean)
  } catch { return [] }
}

// GET config (autenticado). El token se enmascara; hasToken indica si existe.
const getConfig = async (req, res) => {
  try {
    const cfg = await pms.loadConfig(req.params.accId) || {}
    const instaladas = await integracionesDe(req.params.accId)
    res.json({
      ...pms.publicConfig(cfg),
      baseUrl: cfg.baseUrl || '',
      notifyTeam: cfg.notifyTeam !== false,
      postBookingFlowId: cfg.postBookingFlowId || '',
      hasToken: !!cfg.token,
      // Kunas: credenciales del login (usuario visible; contraseña/key enmascaradas).
      hasApiKey: !!cfg.apiKey,
      username: cfg.username || '',
      hasPassword: !!cfg.password,
      propertyId: cfg.propertyId || '',
      pricingPlanId: cfg.pricingPlanId || '',
      blockedProperties: Array.isArray(cfg.blockedProperties) ? cfg.blockedProperties : [],
      blockedRooms: Array.isArray(cfg.blockedRooms) ? cfg.blockedRooms : [],
      roomFeatures: (cfg.roomFeatures && typeof cfg.roomFeatures === 'object') ? cfg.roomFeatures : {},
      providers: providers.listProviders(instaladas),
    })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

// Guarda la configuración. El token solo se actualiza si llega uno nuevo no vacío.
const saveConfig = async (req, res) => {
  const { accId } = req.params
  const { provider, token, apiKey, username, password, propertyId, pricingPlanId, baseUrl, currency, maxPhotos, photoSkip, notifyTeam, postBookingFlowId, blockedProperties, blockedRooms, roomFeatures } = req.body || {}
  try {
    const cur = await pms.loadConfig(accId) || {}
    const next = { ...cur }
    if (provider !== undefined) {
      if (provider && !providers.getProvider(provider)) return res.status(400).json({ error: 'Proveedor desconocido' })
      next.provider = provider || ''
    }
    // Secretos (token / apiKey / contraseña): solo se actualizan con un valor nuevo no enmascarado.
    // Si cambian el token o la contraseña, se descarta la key (pKey) derivada para re-login.
    if (token !== undefined && token !== '' && !String(token).includes('•')) { if (String(token).trim() !== cur.token) { next.apiKey = ''; next.properties = []; next.propertyId = ''; next.hotelName = '' } next.token = String(token).trim() }
    if (apiKey !== undefined && apiKey !== '' && !String(apiKey).includes('•')) next.apiKey = String(apiKey).trim()
    if (username !== undefined) next.username = String(username || '').trim()
    if (password !== undefined && password !== '' && !String(password).includes('•')) { next.password = String(password); next.apiKey = '' }
    if (propertyId !== undefined) next.propertyId = String(propertyId || '').trim()
    if (pricingPlanId !== undefined) next.pricingPlanId = String(pricingPlanId || '').trim()
    if (baseUrl !== undefined) next.baseUrl = String(baseUrl || '').trim()
    if (currency !== undefined) next.currency = String(currency || 'COP').toUpperCase().slice(0, 6)
    if (maxPhotos !== undefined) next.maxPhotos = Math.max(1, Math.min(10, Number(maxPhotos) || 4))
    if (photoSkip !== undefined) next.photoSkip = Math.max(0, Math.min(20, parseInt(photoSkip) || 0))
    if (blockedProperties !== undefined) next.blockedProperties = (Array.isArray(blockedProperties) ? blockedProperties : []).map(String)
    // Caracteristicas por habitacion, escritas por el hotel: { "prop::hab": "jacuzzi, terraza" }
    if (roomFeatures !== undefined && roomFeatures && typeof roomFeatures === 'object') {
      const limpio = {}
      for (const [k, v] of Object.entries(roomFeatures)) {
        const txt = String(v || '').trim().slice(0, 500)
        if (txt) limpio[String(k).slice(0, 120)] = txt
      }
      next.roomFeatures = limpio
    }
    if (blockedRooms !== undefined) next.blockedRooms = (Array.isArray(blockedRooms) ? blockedRooms : []).map(String)
    if (notifyTeam !== undefined) next.notifyTeam = !!notifyTeam
    if (postBookingFlowId !== undefined) next.postBookingFlowId = String(postBookingFlowId || '')
    // Si se cambia de PMS (otro proveedor u otro token), el índice vectorial que había
    // describía los alojamientos del hotel ANTERIOR. Dejarlo sería peor que no tenerlo: el
    // asistente ofrecería habitaciones de un hotel que ya no es el de esta cuenta.
    const cambioDeHotel = (provider !== undefined && next.provider !== cur.provider)
      || (next.token && next.token !== cur.token)
    if (cambioDeHotel) {
      next.vectorIndex = { ...(next.vectorIndex || {}), lastSyncAt: 0, count: 0, error: '' }
      try { await require('../services/productIndex').purge(accId, 'pms') } catch {}
    }
    await pms.saveConfig(accId, next)
    res.json({ ok: true, config: { ...pms.publicConfig(next), hasToken: !!next.token, hasApiKey: !!next.apiKey, username: next.username || '', hasPassword: !!next.password, propertyId: next.propertyId || '', pricingPlanId: next.pricingPlanId || '' } })
  } catch (e) { console.error('[pms saveConfig]', e); res.status(500).json({ error: 'Error interno' }) }
}

// Prueba la conexión con la config GUARDADA.
const test = async (req, res) => {
  try { res.json(await pms.testConnection(req.params.accId)) }
  catch (e) { res.status(502).json({ ok: false, message: e.message }) }
}

// Reinicia las credenciales: borra token/key/propiedad/nombre y desconecta.
// Conserva el proveedor y las preferencias de presentación (moneda, fotos…).
const resetCredentials = async (req, res) => {
  const { accId } = req.params
  try {
    const cur = await pms.loadConfig(accId) || {}
    const next = { ...cur, token: '', apiKey: '', username: '', password: '', propertyId: '', pricingPlanId: '', hotelName: '', properties: [] }
    await pms.saveConfig(accId, next)
    res.json({ ok: true, config: { ...pms.publicConfig(next), hasToken: false, hasApiKey: false, username: '', hasPassword: false, propertyId: '', pricingPlanId: '' } })
  } catch (e) { console.error('[pms resetCredentials]', e); res.status(500).json({ error: 'Error interno' }) }
}

// ── Lectura para la UI: propiedades, habitaciones y disponibilidad ──────────────
const listProperties = async (req, res) => {
  try { res.json({ properties: await pms.listProperties(req.params.accId) }) }
  catch (e) { res.status(502).json({ error: e.message }) }
}
const listRooms = async (req, res) => {
  try { res.json(await pms.listRooms(req.params.accId, { propertyId: req.query.propertyId || '' })) }
  catch (e) { res.status(502).json({ error: e.message }) }
}
const availability = async (req, res) => {
  try {
    const r = await pms.rangeAvailability(req.params.accId, {
      checkin: req.query.checkin, checkout: req.query.checkout,
      adults: req.query.adults, children: req.query.children, propertyId: req.query.propertyId || '',
    })
    res.json(r)
  } catch (e) { res.status(502).json({ error: e.message }) }
}
const monthAvailability = async (req, res) => {
  try {
    const r = await pms.monthAvailability(req.params.accId, {
      year: req.query.year, month: req.query.month, roomTypeId: req.query.roomTypeId || '',
      propertyId: req.query.propertyId || '', adults: req.query.adults,
    })
    res.json(r)
  } catch (e) { res.status(502).json({ error: e.message }) }
}

// Diagnóstico (autenticado): respuestas crudas del PMS para afinar el mapeo.
const debug = async (req, res) => {
  try { res.json(await pms.debug(req.params.accId)) }
  catch (e) { res.status(502).json({ error: e.message }) }
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

module.exports = { getConfig, saveConfig, test, resetCredentials, listProperties, listRooms, availability, monthAvailability, debug, tool }
