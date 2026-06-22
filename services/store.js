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

function isEnabled(cfg) { return impl(cfg).isEnabled(cfg) }
const DEFAULT_MAX_IMAGES = 4
function maxImages(cfg) { const n = parseInt(cfg?.maxImagesPerProduct); return n > 0 ? Math.min(n, 10) : DEFAULT_MAX_IMAGES }

// Config pública (sin secretos) unificada para el navegador / objeto de cuenta.
function publicConfig(cfg) {
  const platform = platformOf(cfg)
  const base = impl(cfg).publicConfig(cfg)
  return {
    ...base,
    platform,
    maxImagesPerProduct: maxImages(cfg),
    gateway: cfg?.gateway || { mode: 'native' },
    abandonedCart: cfg?.abandonedCart || { enabled: false, hours: 20, maxReminders: 1, message: '' },
  }
}

// Operaciones (cargan la config y delegan en la plataforma correcta).
async function searchProducts(accId, query, opts) { const cfg = await loadConfig(accId); return impl(cfg).searchProducts(accId, query, opts) }
async function createOrder(accId, payload) { const cfg = await loadConfig(accId); return impl(cfg).createOrder(accId, payload) }
async function getOrderStatus(accId, rec) { const cfg = await loadConfig(accId); return impl(cfg).getOrderStatus(accId, rec) }
async function testConnection(cfg) { return impl(cfg).testConnection(cfg) }
async function fetchStoreCurrency(cfg) { return impl(cfg).fetchStoreCurrency(cfg) }

module.exports = {
  loadConfig, saveConfig, platformOf, isEnabled, maxImages, publicConfig,
  searchProducts, createOrder, getOrderStatus, testConnection, fetchStoreCurrency, woo, shopify,
}
