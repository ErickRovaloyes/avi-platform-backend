'use strict'
/**
 * Controller del índice VECTORIAL de productos (Woo/Shopify/Catálogo Meta).
 * Config + sync manual + prueba de búsqueda + receivers de webhooks de producto.
 * Los receivers ACKean 200 de inmediato y verifican HMAC antes de encolar.
 */
const productIndex = require('../services/productIndex')
const woo = require('../services/woocommerce')
const shopify = require('../services/shopify')

const srcOf = req => (req.query.source === 'meta' || req.body?.source === 'meta') ? 'meta' : 'store'

// GET /woocommerce/:accId/vector-index (?source=meta)
const vectorStatus = async (req, res) => {
  try { res.json(await productIndex.status(req.params.accId, srcOf(req))) }
  catch (e) { res.status(500).json({ error: e.message || 'Error interno' }) }
}

// PUT /woocommerce/:accId/vector-index — guarda config; gestiona webhooks según el modo.
const vectorSaveSettings = async (req, res) => {
  const { accId } = req.params
  const source = srcOf(req)
  try {
    const b = req.body || {}
    const prev = await productIndex.getSettings(accId, source)
    // El Catálogo Meta no tiene webhooks de producto → siempre programado.
    const mode = source === 'meta' ? 'scheduled' : (b.mode === 'scheduled' ? 'scheduled' : 'realtime')
    const vi = await productIndex.saveSettings(accId, source, {
      enabled: b.enabled !== undefined ? !!b.enabled : prev.enabled,
      mode,
      everyHours: b.everyHours ?? prev.everyHours,
      dayOfWeek: b.dayOfWeek === undefined ? prev.dayOfWeek : b.dayOfWeek,
      hour: b.hour ?? prev.hour,
    })
    // Webhooks (solo fuente 'store'): alta en tiempo real, baja al programar/desactivar.
    let webhookError = ''
    if (source === 'store') {
      const cfg = await woo.loadConfig(accId)
      const isShopify = cfg?.platform === 'shopify'
      if (vi.enabled && vi.mode === 'realtime') {
        try { isShopify ? await shopify.registerProductWebhooks(accId) : await woo.registerProductWebhooks(accId) }
        catch (e) { webhookError = e.message }
      } else {
        try { isShopify ? await shopify.unregisterProductWebhooks(accId) : await woo.unregisterProductWebhooks(accId) } catch {}
      }
    }
    // Primer enable con índice vacío → sync inicial en background.
    if (vi.enabled && !prev.enabled && !vi.count) {
      productIndex.fullSync(accId, source).catch(() => {})
    }
    res.json({ ok: true, settings: await productIndex.status(accId, source), webhookError: webhookError || undefined })
  } catch (e) { res.status(400).json({ error: e.message || 'Error' }) }
}

// POST /woocommerce/:accId/vector-index/sync — dispara la sincronización en background.
const vectorSyncNow = async (req, res) => {
  const { accId } = req.params
  const source = srcOf(req)
  if (productIndex.isSyncing(accId, source)) return res.json({ ok: true, started: false, syncing: true })
  productIndex.fullSync(accId, source).catch(() => {})
  res.json({ ok: true, started: true })
}

// POST /woocommerce/:accId/vector-index/search — prueba desde el panel (con scores no; productos).
const vectorTestSearch = async (req, res) => {
  try {
    const q = String(req.body?.query || '').slice(0, 300)
    if (!q) return res.status(400).json({ error: 'Escribe una consulta.' })
    const r = await productIndex.searchVector(req.params.accId, q, { limit: Number(req.body?.limit) || 6, source: srcOf(req) })
    res.json({ products: Array.isArray(r) ? r : [], indexed: Array.isArray(r) })
  } catch (e) { res.status(400).json({ error: e.message || 'Error' }) }
}

// ── Receivers de webhooks de producto ─────────────────────────────────────────
// POST /woocommerce/product-webhook/:accId (público; verificado por HMAC propio)
const wooProductWebhook = async (req, res) => {
  const { accId } = req.params
  res.sendStatus(200)   // ACK inmediato
  try {
    const cfg = await woo.loadConfig(accId)
    if (!cfg?.vectorIndex?.enabled) return
    if (!req.body || !req.body.id) return   // ping de alta del webhook
    if (!woo.verifyProductSignature(cfg, req.rawBody, req.headers['x-wc-webhook-signature'])) {
      console.warn('[pix woo webhook] firma inválida', accId); return
    }
    const topic = String(req.headers['x-wc-webhook-topic'] || '')
    productIndex.enqueueChange(accId, 'store', String(req.body.id),
      topic === 'product.deleted' ? 'delete' : 'upsert',
      topic === 'product.deleted' ? null : req.body)
  } catch (e) { console.error('[pix woo webhook]', e.message) }
}

// POST /shopify/product-webhook/:accId (público; verificado por HMAC de la app)
const shopifyProductWebhook = async (req, res) => {
  const { accId } = req.params
  res.sendStatus(200)   // Shopify exige respuesta <5s
  try {
    const cfg = await woo.loadConfig(accId)   // misma fila de config (platform shopify)
    if (!cfg?.vectorIndex?.enabled) return
    if (!shopify.verifyWebhook(cfg, req.rawBody, req.headers['x-shopify-hmac-sha256'])) {
      console.warn('[pix shopify webhook] firma inválida', accId); return
    }
    const topic = String(req.headers['x-shopify-topic'] || '')
    const pid = req.body?.id
    if (!pid) return
    productIndex.enqueueChange(accId, 'store', String(pid),
      topic === 'products/delete' ? 'delete' : 'upsert',
      topic === 'products/delete' ? null : req.body)
  } catch (e) { console.error('[pix shopify webhook]', e.message) }
}

module.exports = { vectorStatus, vectorSaveSettings, vectorSyncNow, vectorTestSearch, wooProductWebhook, shopifyProductWebhook }
