'use strict'
/**
 * Dispatcher de PASARELA DE PAGO general (accounts.payments). Una sola config por
 * cuenta con un campo `provider` ('wompi' | 'stripe' | 'paypal' | 'bold' | …). El
 * asistente, los controladores y el webhook usan SIEMPRE este módulo; internamente
 * delega en el adaptador del proveedor. Las llaves nunca salen del servidor.
 *
 * Empezamos con WOMPI. El marco es extensible: añadir un adaptador en
 * services/payments/<provider>.js con la misma interfaz y registrarlo en IMPLS.
 *
 * Persistencia de intentos de pago (payment_intents) + disparo de flujos al
 * confirmarse/rechazarse el pago viven aquí (agnóstico al proveedor).
 */
const pool = require('../db')
const { parseJ, uid } = require('../utils')
const wompi = require('./payments/wompi')

const IMPLS = { wompi }
const providerOf = cfg => (cfg && IMPLS[cfg.provider] ? cfg.provider : 'wompi')
const impl = cfg => IMPLS[providerOf(cfg)]

async function loadConfig(accId) {
  try { const [[a]] = await pool.query('SELECT payments FROM accounts WHERE id=?', [accId]); return parseJ(a?.payments, null) }
  catch { return null }
}
async function saveConfig(accId, cfg) { await pool.query('UPDATE accounts SET payments=? WHERE id=?', [JSON.stringify(cfg || {}), accId]) }

function isEnabled(cfg) { return impl(cfg).isEnabled(cfg) }
function testConnection(cfg) { return impl(cfg).testConnection(cfg) }

// Config pública (sin secretos) para el navegador / objeto de cuenta.
function publicConfig(cfg) {
  const base = impl(cfg).publicConfig(cfg)
  return {
    ...base,
    provider: providerOf(cfg),
    successFlowId: cfg?.successFlowId || null,
    failureFlowId: cfg?.failureFlowId || null,
  }
}

function baseUrl() {
  return (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
}

// ── Crear link de pago + registrar el intento ───────────────────────────────
// amount va en la unidad MAYOR de la moneda (p. ej. 50000 COP). Se convierte a
// "cents" (x100) para Wompi. Devuelve { reference, url, amount, currency }.
async function createPaymentLink(accId, { amount, description, currency, convId, agId } = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La pasarela de pago no está conectada')
  const amt = Number(amount)
  if (!amt || amt <= 0) throw new Error('Monto inválido')
  const cur = (currency || cfg.currency || 'COP').toUpperCase()
  const reference = 'pay_' + uid() + uid()
  const link = await impl(cfg).createPaymentLink(cfg, {
    amountInCents: Math.round(amt * 100), currency: cur,
    name: (description || 'Pago').slice(0, 60), description: description || 'Pago',
    redirectUrl: `${baseUrl()}/pay/return?ref=${reference}`,
  })
  const ts = Date.now()
  await pool.query(
    `INSERT INTO payment_intents
       (id, account_id, agent_id, conv_id, provider, reference, link_id, link_url, amount, currency, description, status, result_notified, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['pi_' + uid(), accId, agId || null, convId || null, providerOf(cfg), reference,
     link.linkId, link.url, amt, cur, (description || 'Pago').slice(0, 255), 'pending', 0, ts, ts]
  )
  return { reference, url: link.url, amount: amt, currency: cur }
}

// Estado del último intento de pago de una conversación (lo usa la IA / proxy).
async function latestIntentStatus(accId, convId) {
  if (!convId) return null
  const [[r]] = await pool.query(
    'SELECT * FROM payment_intents WHERE account_id=? AND conv_id=? ORDER BY created_at DESC LIMIT 1',
    [accId, convId]
  )
  return r || null
}

// ── Webhook: procesa una transacción del proveedor ──────────────────────────
// Verifica la firma, casa el intento de pago (por link_id), actualiza su estado y
// dispara el flujo de ÉXITO o de FALLO configurado en la cuenta (una sola vez).
async function handleWebhook(accId, event) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) return { ok: false, reason: 'gateway off' }
  if (!impl(cfg).verifyEvent(cfg, event)) return { ok: false, reason: 'bad signature' }

  const tx = event?.data?.transaction
  if (!tx) return { ok: false, reason: 'no transaction' }
  const status = impl(cfg).normalizeStatus(tx.status)
  if (status === 'pending') return { ok: true, status: 'pending' } // aún sin resolver

  // Casa el intento por el id del payment link (o por reference como respaldo).
  const linkId = tx.payment_link_id || tx.paymentLinkId || null
  let row = null
  if (linkId) {
    const [[r]] = await pool.query('SELECT * FROM payment_intents WHERE account_id=? AND link_id=? ORDER BY created_at DESC LIMIT 1', [accId, String(linkId)])
    row = r
  }
  if (!row && tx.reference) {
    const [[r]] = await pool.query('SELECT * FROM payment_intents WHERE account_id=? AND reference=? LIMIT 1', [accId, String(tx.reference)])
    row = r
  }
  if (!row) return { ok: true, status, matched: false }

  const now = Date.now()
  await pool.query('UPDATE payment_intents SET status=?, transaction_id=?, updated_at=? WHERE id=?',
    [status, String(tx.id || ''), now, row.id])

  // Sólo dispara una vez por intento.
  if (row.result_notified) return { ok: true, status, alreadyNotified: true }
  await pool.query('UPDATE payment_intents SET result_notified=1 WHERE id=?', [row.id])

  return {
    ok: true, status, matched: true,
    intent: row, transaction: tx,
    flowId: status === 'approved' ? (cfg.successFlowId || null) : (cfg.failureFlowId || null),
  }
}

module.exports = {
  loadConfig, saveConfig, providerOf, isEnabled, testConnection, publicConfig,
  createPaymentLink, latestIntentStatus, handleWebhook,
}
