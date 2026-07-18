'use strict'
/**
 * Integración Shopify (Custom App). Comparte la misma fila de config por cuenta
 * (accounts.woocommerce) con platform:'shopify'. Conexión servidor-a-servidor con
 * el Admin API access token (X-Shopify-Access-Token). Mismas funciones que el
 * servicio de WooCommerce para que el dispatcher (services/store) las use igual.
 */
const crypto = require('crypto')
const pool = require('../db')
const { uid, parseJ } = require('../utils')

const baseUrl = () => (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
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
    // API secret de la custom app: necesaria para VERIFICAR los webhooks de producto
    // (índice vectorial en tiempo real). Sin ella solo funciona el modo programado.
    hasApiSecret: !!cfg?.apiSecret,
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

// ── Índice vectorial: TODOS los productos activos (paginado por cursor) ─────────
const PRODUCTS_PAGE = `query($n:Int!,$cursor:String){ products(first:$n, after:$cursor, query:"status:active"){
  pageInfo{ hasNextPage endCursor }
  edges { node {
    id title handle onlineStoreUrl descriptionHtml totalInventory
    productType vendor tags
    featuredImage { url }
    images(first:6){ edges { node { url } } }
    priceRangeV2 { minVariantPrice { amount currencyCode } }
    variants(first:1){ edges { node { id sku } } }
  } } } }`
async function fetchAllProducts(accId, { pageSize = 50 } = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La tienda Shopify no está conectada.')
  const out = []
  let cursor = null
  for (let i = 0; i < 400; i++) {   // tope de seguridad 20k
    let data
    try {
      data = await graphql(cfg, PRODUCTS_PAGE, { n: pageSize, cursor })
    } catch (e) {
      if (/THROTTLED/i.test(e.message)) { await new Promise(r => setTimeout(r, 2000)); i--; continue }
      throw e
    }
    const conn = data?.products
    for (const e of (conn?.edges || [])) {
      const node = e.node
      const m = mapNode(node, cfg.currency)
      const sku = node.variants?.edges?.[0]?.node?.sku || ''
      const categories = [node.productType, ...(Array.isArray(node.tags) ? node.tags : [])].filter(Boolean)
      out.push({ ...m, sku, categories, descriptionFull: stripHtml(node.descriptionHtml).slice(0, 4000) })
    }
    if (!conn?.pageInfo?.hasNextPage) break
    cursor = conn.pageInfo.endCursor
    await new Promise(r => setTimeout(r, 250))
  }
  return out
}

// Una PÁGINA de productos (panel editable), por cursor. Incluye status y variantId.
async function fetchProductsPage(accId, { perPage = 24, cursor = null, search = '' } = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La tienda Shopify no está conectada.')
  const q = String(search || '').trim()
  const query = `query($n:Int!,$cursor:String,$q:String){ products(first:$n, after:$cursor, query:$q){
    pageInfo{ hasNextPage endCursor }
    edges { node {
      id title handle onlineStoreUrl descriptionHtml totalInventory status productType vendor tags
      featuredImage { url } images(first:6){ edges { node { url } } }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      variants(first:1){ edges { node { id sku } } }
    } } } }`
  const data = await graphql(cfg, query, { n: Math.min(Math.max(perPage, 1), 50), cursor, q: q ? `title:*${q}* OR ${q}` : '' })
  const conn = data?.products
  const products = (conn?.edges || []).map(e => {
    const m = mapNode(e.node, cfg.currency)
    const sku = e.node.variants?.edges?.[0]?.node?.sku || ''
    return { ...m, sku, status: String(e.node.status || '').toLowerCase(), categories: [e.node.productType, ...(e.node.tags || [])].filter(Boolean) }
  })
  return { products, hasMore: !!conn?.pageInfo?.hasNextPage, nextCursor: conn?.pageInfo?.endCursor || null }
}

// Edita un producto EN LA TIENDA (REST). Título/descr/estado + precio de la 1ª variante.
async function updateProduct(accId, productId, patch = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La tienda Shopify no está conectada.')
  const product = { id: Number(productId) }
  if (patch.name !== undefined) product.title = String(patch.name)
  if (patch.description !== undefined) product.body_html = String(patch.description)
  if (patch.status !== undefined) product.status = patch.status === 'publish' ? 'active' : (patch.status || 'active')
  if (patch.regularPrice !== undefined && patch.variantId) {
    product.variants = [{ id: Number(patch.variantId), price: String(patch.regularPrice) }]
  }
  const d = await shopFetch(cfg, `/products/${encodeURIComponent(productId)}.json`, { method: 'PUT', body: { product } })
  const p = d?.product || {}
  const v = (p.variants || [])[0] || {}
  return {
    id: String(p.id), variantId: v.id ? String(v.id) : (patch.variantId || null),
    name: p.title || '', sku: v.sku || '', price: v.price || '', currency: cfg.currency || '',
    permalink: p.handle ? `https://${String(cfg.shopDomain).replace(/^https?:\/\//, '').replace(/\/$/, '')}/products/${p.handle}` : '',
    stockStatus: p.status === 'active' ? 'instock' : '', status: String(p.status || '').toLowerCase(),
    shortDescription: stripHtml(p.body_html).slice(0, 600), description: stripHtml(p.body_html).slice(0, 1500),
    descriptionFull: stripHtml(p.body_html).slice(0, 4000),
    images: (p.images || []).map(im => im.src).filter(Boolean),
    categories: [p.product_type, ...(typeof p.tags === 'string' ? p.tags.split(',').map(s => s.trim()) : [])].filter(Boolean),
  }
}

// ── Webhooks de producto (requieren cfg.apiSecret para verificar el HMAC) ───────
const PRODUCT_TOPICS = ['products/create', 'products/update', 'products/delete']
async function registerProductWebhooks(accId) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('Conecta la tienda antes de activar los webhooks de producto.')
  if (!cfg.apiSecret) throw new Error('Falta la API secret key de la app de Shopify (necesaria para verificar los webhooks). Añádela en la conexión o usa el modo programado.')
  const vi = cfg.vectorIndex || {}
  const existing = Array.isArray(vi.webhooks) ? vi.webhooks : []
  const have = new Set(existing.map(w => w.topic))
  const address = `${baseUrl()}/api/shopify/product-webhook/${accId}`
  for (const topic of PRODUCT_TOPICS) {
    if (have.has(topic)) continue
    const d = await shopFetch(cfg, '/webhooks.json', { method: 'POST', body: { webhook: { topic, address, format: 'json' } } })
    if (d?.webhook?.id) existing.push({ id: d.webhook.id, topic })
  }
  vi.webhooks = existing
  cfg.vectorIndex = vi
  await pool.query('UPDATE accounts SET woocommerce=? WHERE id=?', [JSON.stringify(cfg), accId])
  return existing
}
async function unregisterProductWebhooks(accId) {
  const cfg = await loadConfig(accId)
  const vi = cfg?.vectorIndex
  if (!cfg || !Array.isArray(vi?.webhooks) || !vi.webhooks.length) return
  for (const w of vi.webhooks) {
    try { await shopFetch(cfg, `/webhooks/${encodeURIComponent(w.id)}.json`, { method: 'DELETE' }) } catch { /* best-effort */ }
  }
  vi.webhooks = []
  await pool.query('UPDATE accounts SET woocommerce=? WHERE id=?', [JSON.stringify(cfg), accId])
}
function verifyWebhook(cfg, rawBody, hmacHeader) {
  try {
    if (!cfg?.apiSecret || !hmacHeader || !rawBody) return false
    const digest = crypto.createHmac('sha256', cfg.apiSecret).update(rawBody).digest('base64')
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(hmacHeader)))
  } catch { return false }
}
// El payload del webhook llega en shape REST (body_html, images[].src, variants[],
// product_type, tags como string CSV) → mapear al shape Product estándar.
function mapRestWebhookProduct(p, cfg) {
  const v = (p.variants || [])[0] || {}
  const tags = typeof p.tags === 'string' ? p.tags.split(',').map(s => s.trim()).filter(Boolean) : (p.tags || [])
  const domain = String(cfg?.shopDomain || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  return {
    id: String(p.id),
    variantId: v.id ? String(v.id) : null,
    name: p.title || '',
    sku: v.sku || '',
    price: v.price || '',
    currency: cfg?.currency || '',
    permalink: (p.handle && domain) ? `https://${domain}/products/${p.handle}` : '',
    stockStatus: p.status === 'active' ? 'instock' : '',
    shortDescription: stripHtml(p.body_html).slice(0, 600),
    description: stripHtml(p.body_html).slice(0, 1500),
    descriptionFull: stripHtml(p.body_html).slice(0, 4000),
    images: (p.images || []).map(im => im.src).filter(Boolean),
    categories: [p.product_type, ...tags].filter(Boolean),
  }
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
  fetchAllProducts, fetchProductsPage, updateProduct,
  registerProductWebhooks, unregisterProductWebhooks, verifyWebhook, mapRestWebhookProduct,
}
