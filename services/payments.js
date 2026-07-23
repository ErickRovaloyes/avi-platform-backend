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
const bold = require('./payments/bold')

const IMPLS = { wompi, bold }
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
async function createPaymentLink(accId, { amount, description, currency, convId, agId, meta } = {}) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) throw new Error('La pasarela de pago no está conectada')
  const amt = Number(amount)
  if (!amt || amt <= 0) throw new Error('Monto inválido')
  const cur = (currency || cfg.currency || 'COP').toUpperCase()
  const reference = 'pay_' + uid() + uid()
  const link = await impl(cfg).createPaymentLink(cfg, {
    amountInCents: Math.round(amt * 100), currency: cur,
    name: (description || 'Pago').slice(0, 60), description: description || 'Pago',
    reference,   // algunos proveedores (Bold) lo devuelven en el webhook para casar el intento
    redirectUrl: `${baseUrl()}/pay/return?ref=${reference}`,
  })
  const ts = Date.now()
  await pool.query(
    `INSERT INTO payment_intents
       (id, account_id, agent_id, conv_id, provider, reference, link_id, link_url, amount, currency, description, status, result_notified, meta, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['pi_' + uid(), accId, agId || null, convId || null, providerOf(cfg), reference,
     link.linkId, link.url, amt, cur, (description || 'Pago').slice(0, 255), 'pending', 0,
     meta ? JSON.stringify(meta) : null, ts, ts]
  )
  // Confirmación AUTOMÁTICA por sondeo (además del webhook) para proveedores que exponen
  // el estado del link en vivo (Bold). Así el pago se detecta aunque el webhook no llegue.
  if (convId && typeof impl(cfg).pollStatus === 'function') scheduleBackgroundPolling(accId, convId)
  return { reference, url: link.url, amount: amt, currency: cur }
}

// Sondeo en SEGUNDO PLANO tras crear un link (proveedores con pollStatus, p.ej. Bold):
// confirma el pago AUTOMÁTICAMENTE sin depender del webhook. Acotado (~8 min); se detiene
// al resolverse. Idempotente vía result_notified (no duplica con el webhook ni con
// verificar_pago). Los temporizadores se pierden si el server reinicia (respaldo: webhook
// y la verificación reactiva del asistente).
function scheduleBackgroundPolling(accId, convId) {
  if (!convId) return
  const delays = [20000, 25000, 45000, 90000, 120000, 180000] // 20s → ~8 min acumulado
  let i = 0
  const tick = async () => {
    try {
      const st = await reconcileLatestIntent(accId, convId)
      if (st && st.status !== 'pending') {
        if (st.justResolved) {
          try {
            require('../controllers/payments.controller').finalizePayment(
              accId, { status: st.status, intent: st, transactionId: st.transaction_id, flowId: st.flowId, matched: true }
            )
          } catch (e) { console.warn('[payments poll finalize]', e.message) }
        }
        return // resuelto (por sondeo o webhook) → detener
      }
    } catch (e) { /* reintenta en el siguiente tick */ }
    if (i < delays.length) setTimeout(tick, delays[i++]).unref?.()
  }
  if (i < delays.length) setTimeout(tick, delays[i++]).unref?.()
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

// Reconcilia el último intento consultando el estado EN VIVO del proveedor (sin depender
// del webhook). Si el proveedor soporta pollStatus y el pago ya se resolvió, actualiza el
// intento y marca result_notified de forma ATÓMICA (para no duplicar efectos con el
// webhook). Devuelve la fila con { status, justResolved, flowId }. justResolved=true solo
// la primera vez que se resuelve → el llamador dispara los efectos (chat/pedido/flujo).
async function reconcileLatestIntent(accId, convId) {
  const row = await latestIntentStatus(accId, convId)
  if (!row) return null
  if (row.status !== 'pending') return { ...row, justResolved: false }
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) return { ...row, justResolved: false }
  const im = impl(cfg)
  if (typeof im.pollStatus !== 'function') return { ...row, justResolved: false }
  let live = 'pending'
  try { live = await im.pollStatus(cfg, row) } catch { return { ...row, justResolved: false } }
  if (!live || live === 'pending') return { ...row, justResolved: false }
  const now = Date.now()
  const [r] = await pool.query(
    'UPDATE payment_intents SET status=?, updated_at=?, result_notified=1 WHERE id=? AND result_notified=0',
    [live, now, row.id]
  )
  const justResolved = (r?.affectedRows || 0) > 0
  if (!justResolved) await pool.query('UPDATE payment_intents SET status=?, updated_at=? WHERE id=?', [live, now, row.id])
  const flowId = live === 'approved' ? (cfg.successFlowId || null) : (cfg.failureFlowId || null)
  return { ...row, status: live, justResolved, flowId }
}

// ── Webhook: procesa una transacción del proveedor ──────────────────────────
// Verifica la firma, casa el intento de pago (por link_id o reference), actualiza su
// estado y dispara el flujo de ÉXITO o de FALLO configurado en la cuenta (una sola vez).
// ctx = { body, headers, rawBody }: cada proveedor parsea/verifica su propio formato
// (Wompi firma en el cuerpo; Bold firma en el header x-bold-signature sobre el cuerpo crudo).
async function handleWebhook(accId, ctx) {
  const cfg = await loadConfig(accId)
  if (!isEnabled(cfg)) return { ok: false, reason: 'gateway off' }
  const parsed = impl(cfg).parseEvent(cfg, ctx)
  if (!parsed?.ok) return { ok: false, reason: parsed?.reason || 'invalid event' }

  const status = parsed.status
  if (status === 'pending') return { ok: true, status: 'pending' } // aún sin resolver

  // Casa el intento por el id del payment link (o por reference como respaldo).
  const { linkId, reference, transactionId } = parsed
  let row = null
  if (linkId) {
    const [[r]] = await pool.query('SELECT * FROM payment_intents WHERE account_id=? AND link_id=? ORDER BY created_at DESC LIMIT 1', [accId, String(linkId)])
    row = r
  }
  if (!row && reference) {
    const [[r]] = await pool.query('SELECT * FROM payment_intents WHERE account_id=? AND reference=? LIMIT 1', [accId, String(reference)])
    row = r
  }
  if (!row) return { ok: true, status, matched: false }

  const now = Date.now()
  await pool.query('UPDATE payment_intents SET status=?, transaction_id=?, updated_at=? WHERE id=?',
    [status, String(transactionId || ''), now, row.id])

  // Sólo dispara una vez por intento.
  if (row.result_notified) return { ok: true, status, alreadyNotified: true }
  await pool.query('UPDATE payment_intents SET result_notified=1 WHERE id=?', [row.id])

  return {
    ok: true, status, matched: true,
    intent: row, transactionId: transactionId || null,
    flowId: status === 'approved' ? (cfg.successFlowId || null) : (cfg.failureFlowId || null),
  }
}

module.exports = {
  loadConfig, saveConfig, providerOf, isEnabled, testConnection, publicConfig,
  createPaymentLink, latestIntentStatus, reconcileLatestIntent, handleWebhook,
}
