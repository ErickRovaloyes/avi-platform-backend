'use strict'
/**
 * Adaptador de WOMPI para la pasarela de pago general.
 *
 * Solo API + firma; la persistencia de intentos de pago y el disparo de flujos
 * vive en services/payments.js (igual que store.js vs woocommerce.js). Las llaves
 * (privada / secreto de eventos) NUNCA salen del servidor.
 *
 * Mecanismo:
 *   - Generar link de pago → Wompi "Payment Links" (checkout alojado). Devuelve un
 *     id; la URL pública es https://checkout.wompi.co/l/<id>.
 *   - Detección de pago → WEBHOOK de eventos (transaction.updated). La transacción
 *     trae `payment_link_id`, con el que casamos el intento de pago guardado.
 */
const crypto = require('crypto')

function isEnabled(cfg) {
  return !!(cfg && cfg.provider === 'wompi' && cfg.privateKey && cfg.publicKey)
}

function apiBase(cfg) {
  return cfg?.mode === 'sandbox' ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1'
}
function checkoutBase(cfg) {
  // El checkout alojado de Wompi es el mismo host en prod y sandbox; el id define el entorno.
  return 'https://checkout.wompi.co/l'
}

// Config pública (sin secretos) para el navegador / objeto de cuenta.
function publicConfig(cfg) {
  return {
    provider: 'wompi',
    connected: isEnabled(cfg),
    mode: cfg?.mode === 'sandbox' ? 'sandbox' : 'production',
    currency: (cfg?.currency || 'COP').toUpperCase(),
    hasPublicKey: !!cfg?.publicKey,
    hasPrivateKey: !!cfg?.privateKey,
    hasEventsSecret: !!cfg?.eventsSecret,
  }
}

// Prueba la conexión consultando el comercio (merchant) con la llave pública.
async function testConnection(cfg) {
  if (!cfg?.publicKey) return { ok: false, error: 'Falta la llave pública' }
  try {
    const res = await fetch(`${apiBase(cfg)}/merchants/${encodeURIComponent(cfg.publicKey)}`)
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, error: `Wompi ${res.status}: ${(t || res.statusText).slice(0, 160)}` }
    }
    const j = await res.json().catch(() => ({}))
    const name = j?.data?.name || ''
    return { ok: true, merchant: name }
  } catch (e) { return { ok: false, error: e.message } }
}

// Crea un Payment Link. Devuelve { linkId, url }.
async function createPaymentLink(cfg, { amountInCents, currency, name, description, redirectUrl } = {}) {
  if (!isEnabled(cfg)) throw new Error('Wompi no está conectado')
  const cents = Math.round(Number(amountInCents) || 0)
  if (!cents || cents < 0) throw new Error('Monto inválido')
  const body = {
    name: (name || 'Pago').slice(0, 60),
    description: (description || name || 'Pago').slice(0, 255),
    single_use: true,
    collect_shipping: false,
    currency: (currency || cfg.currency || 'COP').toUpperCase(),
    amount_in_cents: cents,
  }
  if (redirectUrl) body.redirect_url = redirectUrl
  const res = await fetch(`${apiBase(cfg)}/payment_links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.privateKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Wompi ${res.status}: ${(t || res.statusText).slice(0, 200)}`)
  }
  const j = await res.json()
  const linkId = j?.data?.id
  if (!linkId) throw new Error('Wompi no devolvió el id del link')
  return { linkId: String(linkId), url: `${checkoutBase(cfg)}/${linkId}` }
}

// Consulta una transacción por id (para verificación puntual).
async function getTransaction(cfg, transactionId) {
  if (!transactionId) return null
  try {
    const res = await fetch(`${apiBase(cfg)}/transactions/${encodeURIComponent(transactionId)}`, {
      headers: { Authorization: `Bearer ${cfg.privateKey}` },
    })
    if (!res.ok) return null
    const j = await res.json().catch(() => ({}))
    return j?.data || null
  } catch { return null }
}

// Verifica la firma (checksum) de un evento de Wompi. El checksum es el SHA256 de
// la concatenación de: valores de `signature.properties` (resueltos por dot-path
// dentro de `data`) + `timestamp` + el secreto de eventos.
function verifyEvent(cfg, event) {
  try {
    const secret = cfg?.eventsSecret
    if (!secret) return false
    const props = event?.signature?.properties
    const checksum = event?.signature?.checksum
    const timestamp = event?.timestamp
    if (!Array.isArray(props) || !checksum) return false
    let concat = ''
    for (const path of props) {
      const val = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), event.data)
      concat += (val == null ? '' : String(val))
    }
    concat += String(timestamp ?? '')
    concat += secret
    const digest = crypto.createHash('sha256').update(concat).digest('hex').toUpperCase()
    return digest === String(checksum).toUpperCase()
  } catch { return false }
}

// Normaliza el estado de Wompi a nuestro modelo (approved | declined | pending).
function normalizeStatus(wompiStatus) {
  const s = String(wompiStatus || '').toUpperCase()
  if (s === 'APPROVED') return 'approved'
  if (s === 'DECLINED' || s === 'VOIDED' || s === 'ERROR') return 'declined'
  return 'pending'
}

// Verifica la firma y normaliza el evento a { ok, status, reference, linkId, transactionId }.
// ctx = { body, headers, rawBody }; Wompi firma en el CUERPO (event.signature).
function parseEvent(cfg, ctx) {
  const event = ctx?.body || {}
  if (!verifyEvent(cfg, event)) return { ok: false, reason: 'bad signature' }
  const tx = event?.data?.transaction
  if (!tx) return { ok: false, reason: 'no transaction' }
  return {
    ok: true,
    status: normalizeStatus(tx.status),
    linkId: tx.payment_link_id || tx.paymentLinkId || null,
    reference: tx.reference || null,
    transactionId: tx.id || null,
  }
}

module.exports = {
  isEnabled, publicConfig, testConnection,
  createPaymentLink, getTransaction, verifyEvent, normalizeStatus, parseEvent, apiBase, checkoutBase,
}
