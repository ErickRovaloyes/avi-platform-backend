'use strict'
/**
 * Facturación del DUEÑO de la cuenta (autoservicio): catálogo de planes con precio en
 * COP (base) y USD en vivo, la suscripción actual con su uso de contactos, y la tasa
 * de cambio. El checkout + cobro recurrente (Stripe/Wompi) llega en la Etapa 3.
 */
const subs = require('../services/subscriptions')
const fx = require('../services/fx')
const platformBilling = require('../services/platformBilling')

// Catálogo de planes de pago (por familia) con precio COP + USD vivo. Público para
// cualquier miembro autenticado (lo ve el dueño en su panel de planes).
const getCatalog = async (req, res) => {
  try {
    const plans = await subs.listPlans()
    const { rate, updatedAt, stale } = await fx.getRate()
    const toUsd = cop => (rate ? Math.round((Number(cop || 0) / rate) * 100) / 100 : 0)
    const fam = plans
      .filter(p => p.family === 'agente' || p.family === 'crm')
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map(p => ({
        id: p.id, name: p.name, family: p.family,
        contactLimit: p.contactLimit || 0, aiEnabled: p.aiEnabled,
        // Tope de conversaciones atendidas por el Agente IA. En la familia `agente` es EL
        // número del plan (400/1.500/3.000/5.000) y lo que se cobra: sin él, la tarjeta no
        // tenía qué enseñar y salía un guion.
        aiContactLimit: p.aiContactLimit || 0,
        priceCop: p.priceCop || 0, priceUsd: toUsd(p.priceCop || 0),
        isCustomContact: p.isCustomContact, gracePeriodDays: p.gracePeriodDays,
      }))
    res.json({
      fx: { rate, updatedAt, stale },
      agente: fam.filter(p => p.family === 'agente'),
      crm: fam.filter(p => p.family === 'crm'),
    })
  } catch (err) { console.error('[billing catalog]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Tasa de cambio COP↔USD (para refrescar el catálogo en el navegador).
const getFx = async (_req, res) => {
  try { res.json(await fx.getRate()) } catch { res.status(500).json({ error: 'Error interno' }) }
}

// Suscripción actual del dueño + uso de contactos + estado efectivo del plan.
const getMySubscription = async (req, res) => {
  const accId = req.user?.accountId
  if (!accId) return res.status(400).json({ error: 'Sin cuenta activa' })
  try {
    const sub = await subs.getSubscription(accId)
    const planState = sub ? subs.effectivePlanState(sub) : null
    res.json({
      subscription: sub, planState,
      contactCount: sub?.contactCount ?? 0,
      contactLimit: planState?.contactLimit ?? 0,
      // Uso de CONVERSACIONES CON IA. En los planes Agente los contactos de CRM son
      // ilimitados (contactLimit = 0) pero los chats que atiende el agente NO lo son, y sin
      // estos dos campos el panel no tenía con qué medirlos: enseñaba «ilimitados» y daba a
      // entender que no había tope.
      aiContactCount: sub?.aiContactCount ?? 0,
      aiContactLimit: planState?.aiContactLimit ?? 0,
    })
  } catch (err) { console.error('[billing subscription]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Pasarelas disponibles + datos para el widget de Wompi (llave pública + token de aceptación).
const getGateways = async (req, res) => {
  try {
    const avail = await platformBilling.availability()
    const out = { availability: avail }
    if (avail.wompi) out.wompi = await platformBilling.wompiInit()
    res.json(out)
  } catch (err) { console.error('[billing gateways]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Inicia el checkout de un plan. Stripe → { url } para redirigir; Wompi → cobra la tarjeta
// tokenizada (cardToken del widget) y activa la suscripción. Solo el dueño de la cuenta.
const checkout = async (req, res) => {
  const accId = req.user?.accountId
  if (!accId) return res.status(400).json({ error: 'Sin cuenta activa' })
  const { planId, gateway, cardToken, acceptanceToken } = req.body || {}
  if (!planId || !gateway) return res.status(400).json({ error: 'Faltan datos del checkout' })
  try {
    const r = await platformBilling.startCheckout(accId, { planId, gateway, email: req.user?.email, cardToken, acceptanceToken })
    res.json(r)
  } catch (err) { res.status(400).json({ error: err.message || 'No se pudo iniciar el pago' }) }
}

// Webhook de Stripe (sin auth; firma verificada sobre el cuerpo CRUDO req.rawBody).
const webhookStripe = async (req, res) => {
  try {
    const out = await platformBilling.handleStripeWebhook(req.rawBody, req.headers['stripe-signature'])
    if (!out.ok) console.warn('[stripe webhook]', out.reason || 'rechazado')
    res.json({ received: true })
  } catch (e) { console.error('[stripe webhook]', e.message); res.status(200).json({ received: true }) }
}

// Webhook de Wompi (sin auth; firma en el cuerpo del evento).
const webhookWompi = async (req, res) => {
  try { await platformBilling.handleWompiWebhook(req.body || {}) } catch (e) { console.warn('[wompi webhook]', e.message) }
  res.json({ received: true })
}

module.exports = { getCatalog, getFx, getMySubscription, getGateways, checkout, webhookStripe, webhookWompi }
