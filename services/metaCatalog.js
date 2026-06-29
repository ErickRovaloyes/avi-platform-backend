'use strict'
/**
 * Catálogo de Meta (Commerce) — conectar el catálogo de productos de la cuenta
 * (el mismo que usa WhatsApp/Instagram Shopping) y LEER su contenido vía Graph
 * API. Reutiliza el access token de los canales de WhatsApp ya conectados
 * (Embedded Signup / coexistencia), así no hay que pedir credenciales nuevas.
 */
const pool = require('../db')
const { parseJ } = require('../utils')

const GRAPH = 'https://graph.facebook.com/v19.0'

async function graphGet(path, token, params = {}) {
  const qs = new URLSearchParams({ access_token: token, ...params })
  const r = await fetch(`${GRAPH}/${path}?${qs}`)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.error?.message || `Graph HTTP ${r.status}`)
  return d
}

// Reúne las credenciales Meta de los canales de WhatsApp de la cuenta.
async function listWhatsAppCreds(accId) {
  const [rows] = await pool.query('SELECT id, name, channels FROM agents WHERE account_id=?', [accId])
  const out = []
  for (const ag of rows) {
    for (const c of parseJ(ag.channels, [])) {
      if (c.type !== 'whatsapp') continue
      const cfg = c.config || {}
      if (cfg.accessToken && (cfg.businessAccountId || cfg.wabaId)) {
        out.push({
          agentId: ag.id, agentName: ag.name, channelId: c.id,
          token: cfg.accessToken, businessId: cfg.businessAccountId || '', wabaId: cfg.wabaId || '',
          displayPhone: cfg.displayPhone || cfg.verifiedName || '',
        })
      }
    }
  }
  return out
}

// Descubre catálogos accesibles con las credenciales de los canales WhatsApp.
// Devuelve [{ id, name, token, displayPhone }]. (El token se mantiene server-side.)
async function discoverCatalogs(accId) {
  const creds = await listWhatsAppCreds(accId)
  const seen = new Map()
  for (const cr of creds) {
    const tries = []
    if (cr.businessId) tries.push(`${cr.businessId}/owned_product_catalogs`)
    if (cr.wabaId && cr.wabaId !== cr.businessId) tries.push(`${cr.wabaId}/product_catalogs`)
    for (const path of tries) {
      try {
        const d = await graphGet(path, cr.token, { fields: 'id,name', limit: '50' })
        for (const cat of (d.data || [])) {
          if (cat?.id && !seen.has(cat.id)) {
            seen.set(cat.id, { id: cat.id, name: cat.name || cat.id, token: cr.token, displayPhone: cr.displayPhone })
          }
        }
      } catch { /* sigue probando con la otra credencial/edge */ }
    }
  }
  return Array.from(seen.values())
}

// Lee productos de un catálogo (paginado).
async function fetchProducts(catalogId, token, { limit = 50, after } = {}) {
  const params = {
    fields: 'id,retailer_id,name,description,price,currency,availability,image_url,url,brand,category',
    limit: String(Math.min(Math.max(Number(limit) || 50, 1), 100)),
  }
  if (after) params.after = after
  const d = await graphGet(`${catalogId}/products`, token, params)
  return { products: d.data || [], after: d.paging?.cursors?.after || null }
}

// Valida que un catálogo sea legible con el token dado (devuelve el nombre).
async function getCatalogInfo(catalogId, token) {
  const d = await graphGet(`${catalogId}`, token, { fields: 'id,name,product_count' })
  return { id: d.id, name: d.name || catalogId, productCount: d.product_count ?? null }
}

// ── Persistencia en la cuenta ───────────────────────────────────────────────
async function getStored(accId) {
  const [[a]] = await pool.query('SELECT meta_catalog FROM accounts WHERE id=?', [accId])
  return parseJ(a?.meta_catalog, null)
}
async function saveStored(accId, cfg) {
  await pool.query('UPDATE accounts SET meta_catalog=? WHERE id=?', [cfg ? JSON.stringify(cfg) : null, accId])
}

// ── Lectura para la herramienta IA del agente ───────────────────────────────
// Productos del catálogo conectado de la cuenta (vacío si no hay conexión).
async function getProducts(accId, { limit = 100 } = {}) {
  const cfg = await getStored(accId)
  if (!cfg?.catalogId || !cfg?.accessToken) return []
  const { products } = await fetchProducts(cfg.catalogId, cfg.accessToken, { limit })
  return products
}

// Búsqueda local por tokens sobre los productos del catálogo (nombre, descripción,
// marca, categoría, retailer_id). Devuelve los que coinciden, ordenados por relevancia.
async function searchProducts(accId, query, { limit = 100 } = {}) {
  const products = await getProducts(accId, { limit })
  const q = String(query || '').toLowerCase().trim()
  if (!q) return products
  const toks = q.split(/[^a-z0-9áéíóúñü]+/i).filter(w => w.length > 1)
  if (!toks.length) return products
  const scored = products.map(p => {
    const hay = `${p.name || ''} ${p.description || ''} ${p.brand || ''} ${p.category || ''} ${p.retailer_id || ''}`.toLowerCase()
    let sc = 0; for (const t of toks) if (hay.includes(t)) sc += t.length >= 4 ? 2 : 1
    return { p, sc }
  }).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc)
  return scored.map(x => x.p)
}

module.exports = { discoverCatalogs, fetchProducts, getCatalogInfo, getStored, saveStored, listWhatsAppCreds, getProducts, searchProducts }
