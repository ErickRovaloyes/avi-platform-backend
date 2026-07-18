'use strict'
/**
 * Dispatcher de tienda: una sola config por cuenta (accounts.woocommerce) con un
 * campo `platform` ('woocommerce' | 'shopify'). El asistente, los controladores y
 * el worker de recuperación usan SIEMPRE este módulo; internamente delega en el
 * servicio de WooCommerce o de Shopify. Las llaves nunca salen del servidor.
 */
const pool = require('../db')
const { parseJ } = require('../utils')
const woo = require('./woocommerce')
const shopify = require('./shopify')

async function loadConfig(accId) {
  try { const [[a]] = await pool.query('SELECT woocommerce FROM accounts WHERE id=?', [accId]); return parseJ(a?.woocommerce, null) }
  catch { return null }
}
async function saveConfig(accId, cfg) { await pool.query('UPDATE accounts SET woocommerce=? WHERE id=?', [JSON.stringify(cfg || {}), accId]) }

const platformOf = cfg => (cfg?.platform === 'shopify' ? 'shopify' : 'woocommerce')
const impl = cfg => (platformOf(cfg) === 'shopify' ? shopify : woo)

// ── Datos del pedido (checkout) que la IA puede pedir al crear un pedido ─────────
// key = identificador (también el nombre del parámetro de la herramienta crear_pedido);
// label = texto en la UI. Se mapean a billing + shipping en createOrder.
const ORDER_FIELD_CATALOG = [
  { key: 'nombre',        label: 'Nombre completo' },
  { key: 'email',         label: 'Email' },
  { key: 'telefono',      label: 'Teléfono' },
  { key: 'direccion',     label: 'Dirección de envío' },
  { key: 'direccion2',    label: 'Apartamento / referencia' },
  { key: 'ciudad',        label: 'Ciudad' },
  { key: 'departamento',  label: 'Departamento / Estado' },
  { key: 'codigo_postal', label: 'Código postal' },
  { key: 'pais',          label: 'País (código ISO 2 letras, ej. CO)' },
  { key: 'notas',         label: 'Notas del pedido' },
]
const ORDER_FIELD_LABELS = Object.fromEntries(ORDER_FIELD_CATALOG.map(f => [f.key, f.label]))
// Por defecto (si no se configuró): nombre, email y teléfono obligatorios.
const DEFAULT_ORDER_FORM = [{ key: 'nombre', required: true }, { key: 'email', required: true }, { key: 'telefono', required: true }]
// Lista efectiva de campos a pedir (filtra claves inválidas; default si no hay config).
function orderForm(cfg) {
  const f = cfg?.orderForm
  if (Array.isArray(f)) return f.filter(x => x && ORDER_FIELD_LABELS[x.key]).map(x => ({ key: x.key, required: !!x.required }))
  return DEFAULT_ORDER_FORM
}

// ── Mensajes de eventos del pedido (creado / pagado / cambio de estado) ──────────
// mode: 'default' (mensaje integrado) | 'ia' (lo redacta la IA con el prompt activo) |
//       'flow' (ejecuta un flujo, que lleva el mensaje dentro) | 'off' (no envía nada).
const ORDER_EVENTS = ['created', 'paid', 'status']
const DEFAULT_ORDER_NOTIFY = { created: 'default', paid: 'default', status: 'off' }
function orderNotify(cfg) {
  const n = cfg?.orderNotify || {}
  const out = {}
  for (const ev of ORDER_EVENTS) {
    const c = n[ev] || {}
    const mode = ['default', 'ia', 'flow', 'off'].includes(c.mode) ? c.mode : DEFAULT_ORDER_NOTIFY[ev]
    out[ev] = { mode, flowId: c.flowId || null }
  }
  return out
}

function isEnabled(cfg) { return impl(cfg).isEnabled(cfg) }
const DEFAULT_MAX_IMAGES = 4
function maxImages(cfg) { const n = parseInt(cfg?.maxImagesPerProduct); return n > 0 ? Math.min(n, 10) : DEFAULT_MAX_IMAGES }

// Config pública (sin secretos) unificada para el navegador / objeto de cuenta.
function publicConfig(cfg) {
  const platform = platformOf(cfg)
  const base = impl(cfg).publicConfig(cfg)
  const vi = cfg?.vectorIndex || {}
  return {
    ...base,
    platform,
    maxImagesPerProduct: maxImages(cfg),
    gateway: cfg?.gateway || { mode: 'native' },
    abandonedCart: cfg?.abandonedCart || { enabled: false, hours: 20, maxReminders: 1, message: '' },
    orderForm: orderForm(cfg),
    orderNotify: orderNotify(cfg),
    vectorIndex: {   // sin webhookSecret (no sale del servidor)
      enabled: !!vi.enabled, mode: vi.mode === 'scheduled' ? 'scheduled' : 'realtime',
      everyHours: vi.everyHours ?? 24, dayOfWeek: vi.dayOfWeek ?? null, hour: vi.hour ?? 3,
      lastSyncAt: vi.lastSyncAt || 0, count: vi.count || 0, error: vi.error || '',
    },
  }
}

// Operaciones (cargan la config y delegan en la plataforma correcta).
async function searchProducts(accId, query, opts) { const cfg = await loadConfig(accId); return impl(cfg).searchProducts(accId, query, opts) }
// Panel "Productos": página editable + edición bidireccional (escribe a la tienda).
async function fetchProductsPage(accId, opts) { const cfg = await loadConfig(accId); return impl(cfg).fetchProductsPage(accId, opts) }
async function updateProduct(accId, productId, patch) { const cfg = await loadConfig(accId); return impl(cfg).updateProduct(accId, productId, patch) }
// Seguimiento: estado actual de un pedido en la tienda.
async function getOrder(accId, orderId) { const cfg = await loadConfig(accId); return impl(cfg).getOrder(accId, orderId) }
// Búsqueda INTELIGENTE: índice vectorial (si está activo y poblado) con fallback
// silencioso a la búsqueda viva. Require lazy para evitar el ciclo productIndex↔store.
async function searchProductsSmart(accId, query, opts) {
  const productIndex = require('./productIndex')
  return productIndex.searchSmart(accId, query, opts)
}
async function createOrder(accId, payload) { const cfg = await loadConfig(accId); return impl(cfg).createOrder(accId, payload) }
async function getOrderStatus(accId, rec) { const cfg = await loadConfig(accId); return impl(cfg).getOrderStatus(accId, rec) }
async function testConnection(cfg) { return impl(cfg).testConnection(cfg) }
async function fetchStoreCurrency(cfg) { return impl(cfg).fetchStoreCurrency(cfg) }

module.exports = {
  loadConfig, saveConfig, platformOf, isEnabled, maxImages, publicConfig,
  searchProducts, searchProductsSmart, fetchProductsPage, updateProduct, getOrder,
  createOrder, getOrderStatus, testConnection, fetchStoreCurrency, woo, shopify,
  ORDER_FIELD_CATALOG, ORDER_FIELD_LABELS, orderForm, ORDER_EVENTS, orderNotify,
}
