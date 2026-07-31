'use strict'
/**
 * Adaptador Stripe para el cobro RECURRENTE de las suscripciones de la plataforma.
 * Usa Checkout Session (mode=subscription): Stripe aloja el formulario de tarjeta,
 * resuelve 3DS y cobra automáticamente cada mes. La confirmación llega por webhook.
 * Solo API HTTP (sin SDK); las llaves nunca salen del servidor.
 */
const crypto = require('crypto')
const API = 'https://api.stripe.com/v1'

function isEnabled(cfg) { return !!(cfg && cfg.secretKey) }

function form(params) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.append(k, String(v))
  return p
}

async function apiCall(cfg, path, params) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${j?.error?.message || res.statusText}`)
  return j
}

// Verifica la conexión listando 1 producto (llave secreta válida).
async function testConnection(cfg) {
  if (!isEnabled(cfg)) return { ok: false, error: 'Falta la llave secreta' }
  try {
    const res = await fetch(`${API}/products?limit=1`, { headers: { Authorization: `Bearer ${cfg.secretKey}` } })
    if (!res.ok) { const j = await res.json().catch(() => ({})); return { ok: false, error: `Stripe ${res.status}: ${j?.error?.message || ''}` } }
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
}

// Crea una Checkout Session de suscripción mensual y devuelve su URL.
async function createCheckoutSession(cfg, { accId, planId, planName, email, currency, unitAmountMinor, successUrl, cancelUrl }) {
  const params = {
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: email || undefined,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': (currency || 'usd').toLowerCase(),
    'line_items[0][price_data][unit_amount]': Math.round(unitAmountMinor),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': planName || 'Plan AVI',
    'metadata[accId]': accId,
    'metadata[planId]': planId,
    'subscription_data[metadata][accId]': accId,
    'subscription_data[metadata][planId]': planId,
  }
  const j = await apiCall(cfg, '/checkout/sessions', params)
  return { url: j.url, id: j.id }
}

// Verifica la firma del webhook (header stripe-signature: t=..,v1=..) sobre el cuerpo CRUDO.
function verifyWebhook(cfg, rawBody, sigHeader) {
  try {
    if (!cfg?.webhookSecret || !sigHeader || !rawBody) return false
    const parts = Object.fromEntries(String(sigHeader).split(',').map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)] }))
    const t = parts.t, v1 = parts.v1
    if (!t || !v1) return false
    const signed = `${t}.${rawBody.toString('utf8')}`
    const expected = crypto.createHmac('sha256', cfg.webhookSecret).update(signed).digest('hex')
    const a = Buffer.from(expected), b = Buffer.from(v1)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch { return false }
}

module.exports = { isEnabled, testConnection, createCheckoutSession, verifyWebhook }
