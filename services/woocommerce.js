'use strict'
/**
 * Integración WooCommerce (Herramienta IA Especial).
 * La conexión (URL tienda + llaves) se guarda por cuenta en accounts.woocommerce.
 * TODAS las llamadas pasan por el servidor: la llave secreta NUNCA llega al
 * navegador. El asistente (webchat o WhatsApp) consulta productos, los envía con
 * fotos, crea pedidos con link de pago y, vía webhook, confirma el pago.
 */
const crypto = require('crypto')
const pool = require('../db')
const { uid, parseJ } = require('../utils')

const baseUrl = () => (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')

// ── Config por cuenta ──────────────────────────────────────────────────────────
async function loadConfig(accId) {
  try {
    const [[a]] = await pool.query('SELECT woocommerce FROM accounts WHERE id=?', [accId])
    return parseJ(a?.woocommerce, null)
  } catch { return null }
}
async function saveConfig(accId, cfg) {
  await pool.query('UPDATE accounts SET woocommerce=? WHERE id=?', [JSON.stringify(cfg || {}), accId])
}
function isEnabled(cfg) { return !!(cfg && cfg.enabled && cfg.storeUrl && cfg.consumerKey && cfg.consumerSecret) }

// Versión segura para el navegador / objeto público (sin secretos).
function publicConfig(cfg) {
  if (!cfg) return { enabled: false }
  return {
    enabled: !!cfg.enabled,
    storeUrl: cfg.storeUrl || '',
    hasKeys: !!(cfg.consumerKey && cfg.consumerSecret),
    consumerKeyMasked: cfg.consumerKey ? cfg.consumerKey.slice(0, 6) + '…' + cfg.consumerKey.slice(-4) : '',
    gateway: cfg.gateway || { mode: 'native' },
    currency: cfg.currency || '',
    webhookActive: !!(cfg.webhook && cfg.webhook.id),
  }
}

// ── Llamada REST firmada (Basic auth sobre HTTPS) ──────────────────────────────
function apiBase(cfg) { return `${String(cfg.storeUrl).replace(/\/$/, '')}/wp-json/wc/v3` }
function authHeader(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64')
}
async function wooFetch(cfg, path, { method = 'GET', body = null, query = null } = {}) {
  let url = `${apiBase(cfg)}${path}`
  if (query) { const qs = new URLSearchParams(query).toString(); url += (url.includes('?') ? '&' : '?') + qs }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(cfg) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null; try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`
    const err = new Error(`[WooCommerce] ${msg}`); err.status = res.status; err.data = data
    throw err
  }
  return data
}

async function testConnection(cfg) {
  if (!cfg?.storeUrl || !cfg?.consumerKey || !cfg?.consumerSecret) {
    return { ok: false, error: 'Faltan datos de conexión (URL, consumer key y secret).' }
  }
  try {
    const data = await wooFetch(cfg, '/products', { query: { per_page: 1, status: 'publish' } })
    return { ok: true, sample: Array.isArray(data) ? data.length : 0 }
  } catch (e) { return { ok: false, error: e.message } }
}

// ── Productos ──────────────────────────────────────────────────────────────────
const stripHtml = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
function mapProduct(p) {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku || '',
    price: p.price || p.regular_price || '',
    regularPrice: p.regular_price || '',
    salePrice: p.sale_price || '',
    onSale: !!p.on_sale,
    currency: p.currency || '',
    permalink: p.permalink || '',
    stockStatus: p.stock_status || '',
    shortDescription: stripHtml(p.short_description).slice(0, 600),
    description: stripHtml(p.description).slice(0, 1500),
    images: (p.images || []).map(im => im.src).filter(Boolean),
    categories: (p.categories || []).map(c => c.name),
  }
}
async function searchProducts(accId, query, { limit = 8 } = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La tienda WooCommerce no está conectada.')
  const data = await wooFetch(cfg, '/products', {
    query: { search: String(query || '').slice(0, 120), per_page: Math.min(limit, 20), status: 'publish', orderby: 'relevance' },
  })
  return (Array.isArray(data) ? data : []).map(mapProduct)
}
async function getProduct(accId, id) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La tienda WooCommerce no está conectada.')
  return mapProduct(await wooFetch(cfg, `/products/${encodeURIComponent(id)}`))
}

// ── Pedidos + link de pago ─────────────────────────────────────────────────────
function payUrlFor(cfg, order) {
  if (order?.payment_url) return order.payment_url
  const store = String(cfg.storeUrl).replace(/\/$/, '')
  return `${store}/checkout/order-pay/${order.id}/?pay_for_order=true&key=${order.order_key}`
}
async function createOrder(accId, { items, customer = {}, convId = null, agId = null } = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La tienda WooCommerce no está conectada.')
  const lineItems = (items || [])
    .map(it => ({ product_id: Number(it.productId || it.product_id || it.id), quantity: Math.max(1, Number(it.quantity || 1)) }))
    .filter(li => li.product_id)
  if (!lineItems.length) throw new Error('No se indicaron productos válidos para el pedido.')

  const gw = cfg.gateway || { mode: 'native' }
  const body = {
    set_paid: false,
    status: 'pending',
    line_items: lineItems,
    billing: {
      first_name: customer.firstName || customer.name || 'Cliente',
      last_name: customer.lastName || '',
      email: customer.email || '',
      phone: customer.phone || '',
    },
  }
  // Pasarela: nativa (deja que el cliente elija en el order-pay) o forzar una externa.
  if (gw.mode === 'external' && gw.methodId) {
    body.payment_method = gw.methodId
    body.payment_method_title = gw.methodTitle || gw.methodId
  }
  const order = await wooFetch(cfg, '/orders', { method: 'POST', body })
  const pay = payUrlFor(cfg, order)
  const now = Date.now()
  await pool.query(
    `INSERT INTO woo_orders (id,account_id,agent_id,conv_id,order_id,order_key,status,total,currency,pay_url,paid_notified,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    ['woo_' + uid(), accId, agId, convId, String(order.id), order.order_key || '', order.status || 'pending',
     String(order.total || ''), order.currency || cfg.currency || '', pay, now, now]
  ).catch(() => {})
  return {
    orderId: order.id, orderKey: order.order_key, payUrl: pay,
    total: order.total, currency: order.currency || cfg.currency || '',
    status: order.status,
  }
}

// ── Webhook de pago ────────────────────────────────────────────────────────────
async function registerWebhook(accId) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('Conecta la tienda antes de activar el webhook.')
  // Si ya hay uno, no duplicar.
  if (cfg.webhook?.id) return cfg.webhook
  const secret = crypto.randomBytes(24).toString('hex')
  const delivery = `${baseUrl()}/api/woocommerce/webhook/${accId}`
  const wh = await wooFetch(cfg, '/webhooks', {
    method: 'POST',
    body: { name: 'AVI · confirmación de pago', topic: 'order.updated', delivery_url: delivery, secret, status: 'active' },
  })
  cfg.webhook = { id: wh.id, secret }
  await saveConfig(accId, cfg)
  return cfg.webhook
}
function verifySignature(cfg, rawBody, signature) {
  try {
    if (!cfg?.webhook?.secret || !signature || !rawBody) return false
    const digest = crypto.createHmac('sha256', cfg.webhook.secret).update(rawBody).digest('base64')
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(signature)))
  } catch { return false }
}

const PAID_STATUSES = new Set(['processing', 'completed', 'paid'])
// Procesa un order.updated: si el pedido quedó pagado y no se ha confirmado aún,
// devuelve el mapeo conv↔pedido para enviar la confirmación (lo hace el controller).
async function handleOrderUpdate(accId, order) {
  if (!order?.id) return null
  const orderId = String(order.id)
  const status = String(order.status || '').toLowerCase()
  const [[row]] = await pool.query('SELECT * FROM woo_orders WHERE account_id=? AND order_id=? LIMIT 1', [accId, orderId])
  if (!row) return null
  await pool.query('UPDATE woo_orders SET status=?, total=?, currency=?, updated_at=? WHERE id=?',
    [status, String(order.total || row.total || ''), order.currency || row.currency || '', Date.now(), row.id])
  if (!PAID_STATUSES.has(status) || row.paid_notified) return null
  await pool.query('UPDATE woo_orders SET paid_notified=1, updated_at=? WHERE id=?', [Date.now(), row.id])
  return {
    convId: row.conv_id, agId: row.agent_id, orderId,
    total: String(order.total || row.total || ''), currency: order.currency || row.currency || '',
  }
}

module.exports = {
  loadConfig, saveConfig, isEnabled, publicConfig,
  testConnection, searchProducts, getProduct, createOrder,
  registerWebhook, verifySignature, handleOrderUpdate,
}
