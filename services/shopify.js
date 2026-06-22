'use strict'
/**
 * Integración Shopify (Custom App). Comparte la misma fila de config por cuenta
 * (accounts.woocommerce) con platform:'shopify'. Conexión servidor-a-servidor con
 * el Admin API access token (X-Shopify-Access-Token). Mismas funciones que el
 * servicio de WooCommerce para que el dispatcher (services/store) las use igual.
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')

const API_VERSION = '2024-10'
const numId = gid => String(gid || '').split('/').pop()
const stripHtml = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()

async function loadConfig(accId) {
  try { const [[a]] = await pool.query('SELECT woocommerce FROM accounts WHERE id=?', [accId]); return parseJ(a?.woocommerce, null) }
  catch { return null }
}
function isEnabled(cfg) { return !!(cfg && cfg.platform === 'shopify' && cfg.shopDomain && cfg.adminToken) }
function publicConfig(cfg) {
  return {
    platform: 'shopify', connected: isEnabled(cfg),
    shopDomain: cfg?.shopDomain || '',
    hasKeys: !!cfg?.adminToken,
    adminTokenMasked: cfg?.adminToken ? cfg.adminToken.slice(0, 8) + '…' : '',
    currency: cfg?.currency || '',
  }
}

function apiBase(cfg) { return `https://${String(cfg.shopDomain).replace(/^https?:\/\//, '').replace(/\/$/, '')}/admin/api/${API_VERSION}` }
async function shopFetch(cfg, path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${apiBase(cfg)}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': cfg.adminToken },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null; try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!res.ok) {
    const msg = data?.errors ? (typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors)) : `HTTP ${res.status}`
    const err = new Error(`[Shopify] ${msg}`); err.status = res.status; throw err
  }
  return data
}
async function graphql(cfg, query, variables) {
  const data = await shopFetch(cfg, '/graphql.json', { method: 'POST', body: { query, variables } })
  if (data?.errors) throw new Error(`[Shopify] ${JSON.stringify(data.errors)}`)
  return data?.data
}

async function testConnection(cfg) {
  if (!cfg?.shopDomain || !cfg?.adminToken) return { ok: false, error: 'Faltan el dominio .myshopify.com y el Admin API token.' }
  try { const d = await shopFetch(cfg, '/shop.json'); return { ok: true, shop: d?.shop?.name || '' } }
  catch (e) { return { ok: false, error: e.message } }
}
async function fetchStoreCurrency(cfg) {
  try { const d = await shopFetch(cfg, '/shop.json'); return d?.shop?.currency || '' } catch { return '' }
}

const PRODUCT_SEARCH = `query($q:String!,$n:Int!){ products(first:$n, query:$q){ edges { node {
  id title handle onlineStoreUrl descriptionHtml totalInventory
  featuredImage { url }
  images(first:6){ edges { node { url } } }
  priceRangeV2 { minVariantPrice { amount currencyCode } }
  variants(first:1){ edges { node { id } } }
} } } }`
function mapNode(node, cfgCurrency) {
  const v = node.variants?.edges?.[0]?.node
  const imgs = []
  if (node.featuredImage?.url) imgs.push(node.featuredImage.url)
  for (const e of (node.images?.edges || [])) { if (e.node?.url && !imgs.includes(e.node.url)) imgs.push(e.node.url) }
  const amount = node.priceRangeV2?.minVariantPrice?.amount || ''
  return {
    id: numId(node.id),
    variantId: v ? numId(v.id) : null,
    name: node.title,
    price: amount,
    currency: node.priceRangeV2?.minVariantPrice?.currencyCode || cfgCurrency || '',
    permalink: node.onlineStoreUrl || '',
    stockStatus: node.totalInventory > 0 ? 'instock' : (node.totalInventory === 0 ? 'outofstock' : ''),
    shortDescription: stripHtml(node.descriptionHtml).slice(0, 600),
    description: stripHtml(node.descriptionHtml).slice(0, 1500),
    images: imgs,
  }
}
async function searchProducts(accId, query, { limit = 8 } = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La tienda Shopify no está conectada.')
  // El query de Shopify busca por título y demás campos; envolvemos en comodines.
  const q = String(query || '').trim()
  const data = await graphql(cfg, PRODUCT_SEARCH, { q: q ? `title:*${q}* OR ${q}` : '', n: Math.min(limit, 20) })
  return (data?.products?.edges || []).map(e => mapNode(e.node, cfg.currency))
}
async function getProduct(accId, id) {
  const list = await searchProducts(accId, '', { limit: 20 })
  return list.find(p => String(p.id) === String(id)) || null
}

async function createOrder(accId, { items, customer = {}, convId = null, agId = null } = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La tienda Shopify no está conectada.')
  const lineItems = (items || [])
    .map(it => ({ variant_id: Number(it.variantId || it.variant_id), quantity: Math.max(1, Number(it.quantity || 1)) }))
    .filter(li => li.variant_id)
  if (!lineItems.length) throw new Error('No se pudo resolver la variante del producto en Shopify.')
  const draft = await shopFetch(cfg, '/draft_orders.json', {
    method: 'POST',
    body: { draft_order: {
      line_items: lineItems,
      email: customer.email || undefined,
      note: 'Pedido creado por el asistente IA de AVI',
    } },
  })
  const d = draft?.draft_order || {}
  const payUrl = d.invoice_url || ''
  const now = Date.now()
  await pool.query(
    `INSERT INTO woo_orders (id,account_id,agent_id,conv_id,platform,order_id,order_key,status,total,currency,pay_url,paid_notified,reminders_sent,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`,
    ['sho_' + uid(), accId, agId, convId, 'shopify', String(d.id), '', d.status || 'open',
     String(d.total_price || ''), d.currency || cfg.currency || '', payUrl, now, now]
  ).catch(() => {})
  return { orderId: d.id, payUrl, total: d.total_price, currency: d.currency || cfg.currency || '', status: d.status }
}

// Estado de un borrador de pedido: 'completed' = pagado (Shopify crea la Order).
async function getOrderStatus(accId, rec) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) return null
  try {
    const d = await shopFetch(cfg, `/draft_orders/${encodeURIComponent(rec.order_id)}.json`)
    const o = d?.draft_order || {}
    return { status: o.status || rec.status, paid: o.status === 'completed', total: o.total_price || rec.total, currency: o.currency || rec.currency }
  } catch { return null }
}

// Checkouts abandonados nativos (clientes que iniciaron compra en la web y no la
// terminaron). Devuelve los que tienen teléfono y URL de recuperación.
async function fetchAbandonedCheckouts(cfg, sinceMs) {
  try {
    const d = await shopFetch(cfg, `/checkouts.json?limit=50`)
    const list = d?.checkouts || []
    return list.map(c => ({
      id: String(c.id), phone: c.phone || c.billing_address?.phone || c.shipping_address?.phone || '',
      recoveryUrl: c.abandoned_checkout_url || '', total: c.total_price, currency: c.currency,
      createdAt: c.created_at ? new Date(c.created_at).getTime() : 0,
    }))
  } catch { return [] }
}

module.exports = {
  loadConfig, isEnabled, publicConfig, testConnection, fetchStoreCurrency,
  searchProducts, getProduct, createOrder, getOrderStatus, fetchAbandonedCheckouts,
}
