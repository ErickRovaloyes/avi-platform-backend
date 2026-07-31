'use strict'
/**
 * Adaptador Wompi para el cobro RECURRENTE de suscripciones de la plataforma. Wompi no
 * tiene suscripciones nativas: se tokeniza la tarjeta (desde el navegador) → se crea una
 * "payment source" → se cobra el primer mes al suscribir y un worker cobra los siguientes.
 * Reutiliza la verificación de firma del adaptador por-cuenta (services/payments/wompi.js).
 */
const perAccount = require('../payments/wompi')

function apiBase(cfg) { return cfg?.mode === 'sandbox' ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1' }
function isEnabled(cfg) { return !!(cfg && cfg.privateKey && cfg.publicKey) }

async function testConnection(cfg) {
  if (!cfg?.publicKey) return { ok: false, error: 'Falta la llave pública' }
  try {
    const res = await fetch(`${apiBase(cfg)}/merchants/${encodeURIComponent(cfg.publicKey)}`)
    if (!res.ok) { const t = await res.text().catch(() => ''); return { ok: false, error: `Wompi ${res.status}: ${(t || '').slice(0, 140)}` } }
    const j = await res.json().catch(() => ({}))
    return { ok: true, merchant: j?.data?.name || '' }
  } catch (e) { return { ok: false, error: e.message } }
}

// Token de aceptación (términos) presignado del comercio — requerido para tokenizar/cobrar.
async function getAcceptanceToken(cfg) {
  const res = await fetch(`${apiBase(cfg)}/merchants/${encodeURIComponent(cfg.publicKey)}`)
  if (!res.ok) throw new Error(`Wompi merchant ${res.status}`)
  const j = await res.json().catch(() => ({}))
  return j?.data?.presigned_acceptance?.acceptance_token || null
}

// Crea una payment source (tarjeta tokenizada) reutilizable para cobros recurrentes.
async function createPaymentSource(cfg, { token, customerEmail, acceptanceToken }) {
  const res = await fetch(`${apiBase(cfg)}/payment_sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.privateKey}` },
    body: JSON.stringify({ type: 'CARD', token, customer_email: customerEmail, acceptance_token: acceptanceToken }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Wompi payment_source ${res.status}: ${JSON.stringify(j?.error || j).slice(0, 160)}`)
  const id = j?.data?.id
  if (!id) throw new Error('Wompi no devolvió el id de la payment source')
  return String(id)
}

// Cobra un monto con la payment source. Devuelve { id, status } (approved|declined|pending).
async function charge(cfg, { amountInCents, currency = 'COP', customerEmail, paymentSourceId, reference }) {
  const res = await fetch(`${apiBase(cfg)}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.privateKey}` },
    body: JSON.stringify({
      amount_in_cents: Math.round(amountInCents), currency, customer_email: customerEmail,
      payment_source_id: Number(paymentSourceId), reference, recurrent: true,
    }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Wompi transaction ${res.status}: ${JSON.stringify(j?.error || j).slice(0, 160)}`)
  const tx = j?.data
  return { id: tx?.id || null, status: perAccount.normalizeStatus(tx?.status) }
}

// Verifica la firma del evento (con el secreto de eventos de la plataforma) y normaliza.
function parseEvent(cfg, event) {
  if (!perAccount.verifyEvent({ eventsSecret: cfg.eventsSecret }, event)) return { ok: false, reason: 'bad signature' }
  const tx = event?.data?.transaction
  if (!tx) return { ok: false, reason: 'no transaction' }
  return { ok: true, status: perAccount.normalizeStatus(tx.status), reference: tx.reference || null, transactionId: tx.id || null }
}

module.exports = { isEnabled, apiBase, testConnection, getAcceptanceToken, createPaymentSource, charge, parseEvent }
