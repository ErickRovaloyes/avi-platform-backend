'use strict'
const pool = require('../db')
const { parseJ } = require('../utils')
const woo = require('../services/woocommerce')
const store = require('../services/store')
const flowStore = require('../flow/store')
const { sendWhatsAppText, sendMessengerText, sendInstagramText } = require('../services/metaSend')

// Entrega un texto a la conversación: queda en la bandeja/webchat (socket) y,
// si el chat es de un canal externo (WhatsApp/Messenger/IG), también se envía allí.
async function sendConversationMessage(accId, agId, convId, text) {
  if (!convId) return
  try { await flowStore.appendMsg(accId, agId, convId, { sender: 'ai', content: text }) } catch (e) { console.warn('[woo msg]', e.message) }
  try {
    const [[c]] = await pool.query('SELECT channel_type, wa_from, messenger_from, ig_from FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!c || c.channel_type === 'webchat' || c.channel_type === 'test') return
    const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
    const channels = parseJ(ag?.channels, [])
    if (c.channel_type === 'whatsapp') {
      const cfg = (channels.find(ch => ch.type === 'whatsapp' && ch.status === 'connected') || {}).config || {}
      if (cfg.phoneNumberId && cfg.accessToken && c.wa_from) await sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: c.wa_from, text })
    } else if (c.channel_type === 'messenger') {
      const cfg = (channels.find(ch => ch.type === 'messenger' && ch.status === 'connected') || {}).config || {}
      if (cfg.pageAccessToken && c.messenger_from) await sendMessengerText({ pageAccessToken: cfg.pageAccessToken, recipientId: c.messenger_from, text })
    } else if (c.channel_type === 'instagram') {
      const cfg = (channels.find(ch => ch.type === 'instagram' && ch.status === 'connected') || {}).config || {}
      if (cfg.pageAccessToken && c.ig_from) await sendInstagramText({ igAccountId: cfg.igAccountId, pageAccessToken: cfg.pageAccessToken, recipientId: c.ig_from, text })
    }
  } catch (e) { console.warn('[woo deliver]', e.message) }
}

// ── Config (autenticado) ───────────────────────────────────────────────────────
const getConfig = async (req, res) => {
  try { res.json(store.publicConfig(await store.loadConfig(req.params.accId))) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// Guarda la conexión (WooCommerce o Shopify). Si los secretos vienen vacíos se
// conservan los actuales. Prueba la conexión, autodetecta la moneda y (en Woo)
// registra el webhook de pago.
const saveConfig = async (req, res) => {
  const { accId } = req.params
  try {
    const cur = await store.loadConfig(accId) || {}
    const b = req.body || {}
    const platform = (b.platform === 'shopify' || (b.platform === undefined && cur.platform === 'shopify')) ? 'shopify' : 'woocommerce'
    const cfg = {
      ...cur,
      platform,
      // WooCommerce
      storeUrl: (b.storeUrl ?? cur.storeUrl ?? '').trim().replace(/\/$/, ''),
      consumerKey: (b.consumerKey && b.consumerKey.trim()) || cur.consumerKey || '',
      consumerSecret: (b.consumerSecret && b.consumerSecret.trim()) || cur.consumerSecret || '',
      // Shopify
      shopDomain: (b.shopDomain ?? cur.shopDomain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
      adminToken: (b.adminToken && b.adminToken.trim()) || cur.adminToken || '',
      // API secret de la app de Shopify: solo para VERIFICAR webhooks de producto
      // (índice vectorial en tiempo real). Conservar-si-vacío.
      apiSecret: (b.apiSecret && b.apiSecret.trim()) || cur.apiSecret || '',
      // Compartido
      gateway: b.gateway || cur.gateway || { mode: 'native' },
      currency: b.currency ?? cur.currency ?? '',
      maxImagesPerProduct: b.maxImagesPerProduct != null ? Math.max(1, Math.min(10, parseInt(b.maxImagesPerProduct) || 4)) : (cur.maxImagesPerProduct ?? 4),
      abandonedCart: b.abandonedCart || cur.abandonedCart || { enabled: false, hours: 20, maxReminders: 1, message: '' },
      // Datos a pedir al crear un pedido (envío/facturación): [{ key, required }].
      orderForm: Array.isArray(b.orderForm) ? b.orderForm.map(f => ({ key: String(f.key), required: !!f.required })) : (cur.orderForm || undefined),
      // Mensajes de eventos del pedido: { created|paid|status: { mode, flowId } }.
      orderNotify: b.orderNotify && typeof b.orderNotify === 'object' ? b.orderNotify : (cur.orderNotify || undefined),
      webhook: cur.webhook || null,
    }
    // Si cambia la tienda/llaves, invalida el webhook anterior (apunta a otra tienda)
    // y PURGA el índice vectorial (pertenece a la tienda anterior).
    const storeChanged = cur.storeUrl !== cfg.storeUrl || cur.consumerKey !== cfg.consumerKey || cur.shopDomain !== cfg.shopDomain
    if (storeChanged) {
      cfg.webhook = null
      if (cfg.vectorIndex) cfg.vectorIndex = { ...cfg.vectorIndex, webhooks: [], webhookSecret: '', lastSyncAt: 0, count: 0, error: '' }
      try { await require('../services/productIndex').purge(accId, cur.platform === 'shopify' ? 'shopify' : 'woocommerce') } catch {}
    }
    await store.saveConfig(accId, cfg)

    let connection = { ok: false }
    if (store.isEnabled(cfg)) {
      connection = await store.testConnection(cfg)
      if (connection.ok) {
        if (!cfg.currency) {
          const detected = await store.fetchStoreCurrency(cfg)
          if (detected) { cfg.currency = detected; await store.saveConfig(accId, cfg) }
        }
        // El webhook instantáneo de pago solo aplica a WooCommerce; Shopify se
        // confirma por sondeo en el worker de recuperación.
        if (platform === 'woocommerce' && !cfg.webhook?.id) {
          try { await woo.registerWebhook(accId) } catch (e) { connection.webhookError = e.message }
        }
      }
    }
    res.json({ ok: true, connection, config: store.publicConfig(await store.loadConfig(accId)) })
  } catch (e) { console.error('[store saveConfig]', e); res.status(500).json({ error: e.message || 'Error interno' }) }
}

const testConnection = async (req, res) => {
  try { res.json(await store.testConnection(await store.loadConfig(req.params.accId))) }
  catch (e) { res.status(400).json({ error: e.message }) }
}

// ── Proxy público (lo usan el webchat-en-navegador y el motor) ─────────────────
const products = async (req, res) => {
  try {
    const q = req.body?.query ?? req.query.query ?? ''
    // Búsqueda inteligente: índice vectorial si está activo, con fallback a la API viva.
    res.json({ products: await store.searchProductsSmart(req.params.accId, q, { limit: Number(req.body?.limit) || 8 }) })
  } catch (e) { res.status(400).json({ error: e.message }) }
}
const createOrder = async (req, res) => {
  try {
    const { items, customer, convId, agId } = req.body || {}
    res.json(await store.createOrder(req.params.accId, { items, customer, convId, agId }))
  } catch (e) { res.status(400).json({ error: e.message }) }
}
// Seguimiento del pedido (proxy público para el webchat/motor browser).
const orderStatus = async (req, res) => {
  const { accId } = req.params
  try {
    let orderId = String(req.body?.numero_pedido || '').replace(/[^\d]/g, '')
    if (!orderId && req.body?.convId) {
      const [[r]] = await pool.query('SELECT order_id FROM woo_orders WHERE account_id=? AND conv_id=? ORDER BY created_at DESC LIMIT 1', [accId, req.body.convId])
      orderId = r?.order_id || ''
    }
    if (!orderId) return res.json({ found: false, needNumber: true })
    const o = await store.getOrder(accId, orderId)
    if (!o) return res.json({ found: false })
    res.json({ found: true, ...o, statusEs: require('../services/orderNotify').statusEs(o.status) })
  } catch (e) { res.status(400).json({ error: e.message }) }
}

// ── Pestaña "Productos" (autenticado): listar + editar (conexión doble canal) ───
const productIndex = require('../services/productIndex')
// GET /woocommerce/:accId/all-products?page=&cursor=&search=&mode=
//   mode='semantic' → busca por la BASE VECTORIAL (comparación); si no, búsqueda
//   tradicional (API de la tienda). En ambos casos marca `indexed` por producto.
const listProducts = async (req, res) => {
  const { accId } = req.params
  try {
    const search = String(req.query.search || '')
    if (req.query.mode === 'semantic') {
      if (!search.trim()) return res.json({ products: [], hasMore: false, semantic: true })
      const r = await productIndex.searchVector(accId, search, { limit: 30, source: 'store' })
      // null = índice vacío o sin API key de OpenAI → el front lo indica.
      if (r === null) return res.json({ products: [], hasMore: false, semantic: true, unavailable: true })
      return res.json({ products: (r || []).map(p => ({ ...p, indexed: true })), hasMore: false, semantic: true })
    }
    const r = await store.fetchProductsPage(accId, {
      page: Number(req.query.page) || 1,
      cursor: req.query.cursor || null,
      search,
    })
    const idx = await productIndex.indexedIds(accId, 'store').catch(() => new Set())
    r.products = (r.products || []).map(p => ({ ...p, indexed: idx.has(String(p.id)) }))
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
}
// PUT /woocommerce/:accId/products/:productId → edita en la tienda + refresca el índice.
const updateProduct = async (req, res) => {
  const { accId, productId } = req.params
  try {
    const p = await store.updateProduct(accId, productId, req.body || {})
    // Si el índice está activo, refresca esta ficha ya (sin esperar al webhook).
    let indexed = false
    try {
      const vi = await productIndex.getSettings(accId, 'store')
      if (vi.enabled) { await productIndex.syncOne(accId, 'store', String(p.id)).catch(() => {}); indexed = (await productIndex.indexedIds(accId, 'store')).has(String(p.id)) }
    } catch {}
    res.json({ ...p, indexed })
  } catch (e) { res.status(400).json({ error: e.message }) }
}

// ── Webhook de WooCommerce (order.updated) ─────────────────────────────────────
const webhook = async (req, res) => {
  const { accId } = req.params
  res.sendStatus(200) // ACK inmediato a WooCommerce
  try {
    const cfg = await woo.loadConfig(accId)
    const sig = req.headers['x-wc-webhook-signature']
    // El "ping" de alta del webhook no trae order; lo ignoramos en silencio.
    if (!req.body || !req.body.id) return
    if (!woo.verifySignature(cfg, req.rawBody, sig)) { console.warn('[woo webhook] firma inválida', accId); return }
    const mapping = await woo.handleOrderUpdate(accId, req.body)
    if (mapping?.convId) {
      const orderNotify = require('../services/orderNotify')
      const vars = { pedido_id: mapping.orderId, total: mapping.total, currency: mapping.currency, pedido_estado: mapping.status }
      // Pago confirmado tiene prioridad (una transición a pagado también es cambio de estado).
      if (mapping.paidNow) await orderNotify.emit(accId, mapping.agId, mapping.convId, 'paid', vars)
      else if (mapping.statusChanged) await orderNotify.emit(accId, mapping.agId, mapping.convId, 'status', vars)
    }
  } catch (e) { console.error('[woo webhook]', e.message) }
}

module.exports = { getConfig, saveConfig, testConnection, products, createOrder, orderStatus, webhook, sendConversationMessage, listProducts, updateProduct }
