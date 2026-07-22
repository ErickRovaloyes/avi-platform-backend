'use strict'
/**
 * Adaptador de BOLD (bold.co) para la pasarela de pago general.
 *
 * Solo API + firma; la persistencia de intentos de pago y el disparo de flujos
 * vive en services/payments.js. Las llaves NUNCA salen del servidor.
 *
 * Mecanismo:
 *   - Generar link de pago → Bold "Link de pago" API:
 *       POST https://integrations.api.bold.co/online/link/v1
 *       Header  Authorization: x-api-key <llave_de_identidad>
 *       Body    { amount_type:"CLOSE", amount:{currency,total_amount,tip_amount}, reference, description, callback_url }
 *       Resp    { payload:{ payment_link:"LNK_xxx", url:"https://checkout.bold.co/LNK_xxx" } }
 *     OJO: total_amount va en la unidad MAYOR (10000 = 10000 COP, NO centavos).
 *   - Detección de pago → WEBHOOK. Evento CloudEvents con `type` (SALE_APPROVED /
 *     SALE_REJECTED) y `data.metadata.reference` = NUESTRA referencia (con la que
 *     casamos el intento de pago). Firma en el header `x-bold-signature`:
 *       hex( HMAC_SHA256( secreto, base64(cuerpo_crudo) ) )   (secreto = '' en sandbox)
 *
 * Doc: https://developers.bold.co/pagos-en-linea/api-link-de-pagos y .../webhook
 */
const crypto = require('crypto')

const API_BASE = 'https://integrations.api.bold.co'
const CHECKOUT_BASE = 'https://checkout.bold.co'

// Bold autentica SOLO con la llave de identidad (API key), guardada en privateKey.
function isEnabled(cfg) {
  return !!(cfg && cfg.provider === 'bold' && cfg.privateKey)
}

function authHeader(cfg) {
  return `x-api-key ${cfg.privateKey}`
}

// Secreto para verificar la firma del webhook. En sandbox Bold usa cadena vacía.
function eventsSecret(cfg) {
  return cfg?.mode === 'sandbox' ? '' : (cfg?.eventsSecret || '')
}

// Config pública (sin secretos) para el navegador / objeto de cuenta.
function publicConfig(cfg) {
  return {
    provider: 'bold',
    connected: isEnabled(cfg),
    mode: cfg?.mode === 'sandbox' ? 'sandbox' : 'production',
    currency: (cfg?.currency || 'COP').toUpperCase(),
    hasPublicKey: false,               // Bold no usa llave pública en el servidor
    hasPrivateKey: !!cfg?.privateKey,  // = llave de identidad (API key)
    hasEventsSecret: !!cfg?.eventsSecret,
  }
}

// Prueba de conexión: consulta un link inexistente. Con la llave OK → 404/400 (no 401/403);
// con la llave mala → 401/403. No crea nada (lectura pura).
async function testConnection(cfg) {
  if (!cfg?.privateKey) return { ok: false, error: 'Falta la llave de identidad (API key) de Bold' }
  try {
    const res = await fetch(`${API_BASE}/online/link/v1/__conn_test__`, {
      headers: { Authorization: authHeader(cfg), Accept: 'application/json' },
    })
    if (res.status === 401 || res.status === 403) {
      const t = await res.text().catch(() => '')
      return { ok: false, error: `Bold ${res.status}: llave inválida. ${(t || res.statusText).slice(0, 140)}` }
    }
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
}

// Crea un Link de pago. Devuelve { linkId, url }.
// amountInCents llega en centavos (unidad menor); Bold quiere la unidad MAYOR → /100.
async function createPaymentLink(cfg, { amountInCents, currency, name, description, redirectUrl, reference } = {}) {
  if (!isEnabled(cfg)) throw new Error('Bold no está conectado')
  const total = Math.round((Number(amountInCents) || 0) / 100)
  if (!total || total <= 0) throw new Error('Monto inválido')
  const desc = String(description || name || 'Pago').slice(0, 100)
  const body = {
    amount_type: 'CLOSE',
    amount: {
      currency: (currency || cfg.currency || 'COP').toUpperCase(),
      total_amount: total,
      tip_amount: 0,
    },
    description: desc.length < 2 ? 'Pago' : desc,
  }
  if (reference) body.reference = String(reference).slice(0, 60)
  if (redirectUrl) body.callback_url = redirectUrl
  const res = await fetch(`${API_BASE}/online/link/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(cfg) },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || (Array.isArray(j?.errors) && j.errors.length)) {
    const err = (Array.isArray(j?.errors) && j.errors.length ? j.errors.join('; ') : '') || res.statusText
    throw new Error(`Bold ${res.status}: ${String(err).slice(0, 200)}`)
  }
  const linkId = j?.payload?.payment_link
  const url = j?.payload?.url || (linkId ? `${CHECKOUT_BASE}/${linkId}` : '')
  if (!linkId || !url) throw new Error('Bold no devolvió el link de pago')
  return { linkId: String(linkId), url }
}

// Consulta el estado de un link de pago (verificación puntual).
async function getLinkStatus(cfg, linkId) {
  if (!linkId) return null
  try {
    const res = await fetch(`${API_BASE}/online/link/v1/${encodeURIComponent(linkId)}`, {
      headers: { Authorization: authHeader(cfg), Accept: 'application/json' },
    })
    if (!res.ok) return null
    const j = await res.json().catch(() => ({}))
    return j?.payload || j || null
  } catch { return null }
}

// Verifica la firma del webhook: hex(HMAC_SHA256(secreto, base64(cuerpo_crudo))) === x-bold-signature.
function verifyEvent(cfg, ctx) {
  try {
    const received = ctx?.headers?.['x-bold-signature']
    if (!received) return false
    const raw = ctx?.rawBody && ctx.rawBody.length ? ctx.rawBody : Buffer.from(JSON.stringify(ctx?.body || {}))
    const encoded = Buffer.from(raw).toString('base64')
    const hashed = crypto.createHmac('sha256', eventsSecret(cfg)).update(encoded).digest('hex')
    const a = Buffer.from(hashed.toLowerCase())
    const b = Buffer.from(String(received).toLowerCase())
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch { return false }
}

// Normaliza el estado de Bold a nuestro modelo (approved | declined | pending).
function normalizeStatus(boldType) {
  const t = String(boldType || '').toUpperCase()
  if (t === 'SALE_APPROVED') return 'approved'
  if (t === 'SALE_REJECTED' || t === 'VOID_APPROVED' || t === 'VOID_REJECTED') return 'declined'
  return 'pending'
}

// Verifica la firma y normaliza el evento a { ok, status, reference, linkId, transactionId }.
// Bold no manda el id del link en el webhook → se casa por `data.metadata.reference`.
function parseEvent(cfg, ctx) {
  if (!verifyEvent(cfg, ctx)) return { ok: false, reason: 'bad signature' }
  const event = ctx?.body || {}
  const data = event.data || {}
  return {
    ok: true,
    status: normalizeStatus(event.type),
    linkId: data.payment_link || null,
    reference: (data.metadata && data.metadata.reference) || null,
    transactionId: data.payment_id || event.subject || null,
  }
}

module.exports = {
  isEnabled, publicConfig, testConnection,
  createPaymentLink, getLinkStatus, verifyEvent, normalizeStatus, parseEvent, API_BASE, CHECKOUT_BASE,
}
