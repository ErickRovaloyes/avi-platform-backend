'use strict'
const svc = require('../services/metaCatalog')
const socket = require('../services/socket')

const masked = cfg => cfg?.catalogId ? { connected: true, catalogId: cfg.catalogId, name: cfg.name || cfg.catalogId, connectedAt: cfg.connectedAt || null } : { connected: false }

// GET /api/accounts/:accId/meta-catalog → estado de conexión (sin token).
const get = async (req, res) => {
  try { res.json(masked(await svc.getStored(req.params.accId))) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// GET /api/accounts/:accId/meta-catalog/discover → catálogos detectables con los
// canales de WhatsApp conectados.
const discover = async (req, res) => {
  try {
    const cats = await svc.discoverCatalogs(req.params.accId)
    res.json({ catalogs: cats.map(c => ({ id: c.id, name: c.name, displayPhone: c.displayPhone })) })
  } catch (err) { console.error('[metaCatalog discover]', err.message); res.status(502).json({ error: err.message || 'No se pudieron detectar catálogos' }) }
}

// POST /api/accounts/:accId/meta-catalog  { catalogId, accessToken? }
// Conecta un catálogo. Si no se pasa accessToken, lo resuelve desde los canales
// de WhatsApp (auto-detección). Valida leyendo la info del catálogo.
const connect = async (req, res) => {
  const { accId } = req.params
  const { catalogId, accessToken } = req.body || {}
  if (!catalogId) return res.status(400).json({ error: 'catalogId requerido' })
  try {
    let token = accessToken || ''
    if (!token) {
      const cats = await svc.discoverCatalogs(accId)
      token = cats.find(c => c.id === String(catalogId))?.token || ''
      if (!token) return res.status(400).json({ error: 'No se encontró un canal de WhatsApp con acceso a ese catálogo. Conecta WhatsApp o pega un Access Token con permiso de catálogo.' })
    }
    const info = await svc.getCatalogInfo(catalogId, token)   // valida acceso
    const cfg = { catalogId: String(catalogId), name: info.name, accessToken: token, connectedAt: Date.now() }
    await svc.saveStored(accId, cfg)
    socket.emit(accId, 'account:updated', { accId })
    res.json(masked(cfg))
  } catch (err) { console.error('[metaCatalog connect]', err.message); res.status(502).json({ error: err.message || 'No se pudo conectar el catálogo' }) }
}

// GET /api/accounts/:accId/meta-catalog/products?limit=&after=
const products = async (req, res) => {
  try {
    const cfg = await svc.getStored(req.params.accId)
    if (!cfg?.catalogId || !cfg?.accessToken) return res.status(400).json({ error: 'No hay un catálogo conectado.' })
    const r = await svc.fetchProducts(cfg.catalogId, cfg.accessToken, { limit: req.query.limit, after: req.query.after })
    res.json(r)
  } catch (err) { console.error('[metaCatalog products]', err.message); res.status(502).json({ error: err.message || 'No se pudieron leer los productos' }) }
}

// DELETE /api/accounts/:accId/meta-catalog
const disconnect = async (req, res) => {
  try { await svc.saveStored(req.params.accId, null); socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId }); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { get, discover, connect, products, disconnect }
