'use strict'
/**
 * Facturación de la PLATAFORMA al dueño (cobro recurrente de la suscripción). Distinto
 * de services/payments.js (que es el cobro de cada cuenta a SUS clientes). Orquesta el
 * checkout y los cobros con los adaptadores de pasarela + el motor de suscripciones.
 *
 *   Stripe → Checkout Session (mode=subscription): recurrencia automática; confirma por webhook.
 *   Wompi  → Payment Link (checkout ALOJADO): se redirige a la pasarela externa de Wompi y el
 *            plan se activa cuando su webhook confirma la transacción. Sin tarjeta guardada no
 *            hay cobro automático: al vencer el ciclo la cuenta entra en gracia y el dueño
 *            renueva desde el panel. Las cuentas antiguas con payment source siguen cobrándose
 *            solas con `chargeWompiRenewals`.
 */
const pool = require('../db')
const { uid } = require('../utils')
const subs = require('./subscriptions')
const fx = require('./fx')
const stripe = require('./platformGateways/stripe')
const wompi = require('./platformGateways/wompi')

const DAY = 86400000

function baseUrl() {
  return (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
}

async function loadConfig() {
  const [[r]] = await pool.query('SELECT wompi_public_key, wompi_private_key, wompi_events_secret, wompi_mode, stripe_secret_key, stripe_publishable_key, stripe_webhook_secret FROM platform_settings WHERE id=1')
  return {
    stripe: { secretKey: r?.stripe_secret_key || '', publishableKey: r?.stripe_publishable_key || '', webhookSecret: r?.stripe_webhook_secret || '' },
    wompi: { publicKey: r?.wompi_public_key || '', privateKey: r?.wompi_private_key || '', eventsSecret: r?.wompi_events_secret || '', mode: r?.wompi_mode || 'production' },
  }
}

async function getPlan(planId) {
  const [[p]] = await pool.query('SELECT * FROM subscription_plans WHERE id=?', [planId])
  return p ? subs.mapPlan(p) : null
}

// Info pública para inicializar el widget de Wompi en el navegador (tokeniza la tarjeta
// del lado del cliente; los datos de tarjeta NUNCA pasan por nuestro servidor).
async function wompiInit() {
  const cfg = await loadConfig()
  if (!wompi.isEnabled(cfg.wompi)) return { enabled: false }
  let acceptanceToken = null
  try { acceptanceToken = await wompi.getAcceptanceToken(cfg.wompi) } catch { /* la API dará error luego */ }
  return { enabled: true, publicKey: cfg.wompi.publicKey, mode: cfg.wompi.mode, apiBase: wompi.apiBase(cfg.wompi), acceptanceToken }
}

// ¿Qué pasarelas están disponibles? (para mostrar/ocultar en el checkout).
async function availability() {
  const cfg = await loadConfig()
  return { stripe: stripe.isEnabled(cfg.stripe), wompi: wompi.isEnabled(cfg.wompi) }
}

// Guarda datos de pasarela/cobro tras activar/renovar.
async function setGatewayDetails(accId, patch) {
  const cols = { gateway: 'gateway', currency: 'currency', amountCop: 'charge_amount_cop', amountUsd: 'charge_amount_usd', stripeCustomerId: 'stripe_customer_id', stripeSubscriptionId: 'stripe_subscription_id', wompiPaymentSourceId: 'wompi_payment_source_id', nextChargeAt: 'next_charge_at' }
  const sets = [], vals = []
  for (const [k, col] of Object.entries(cols)) if (patch[k] !== undefined) { sets.push(`${col}=?`); vals.push(patch[k]) }
  if (!sets.length) return
  sets.push('updated_at=?'); vals.push(Date.now(), accId)
  await pool.query(`UPDATE account_subscriptions SET ${sets.join(',')} WHERE account_id=?`, vals)
}

// Tipo de cuenta por defecto según la familia del plan de pago: Agente → 'Starter', CRM → 'CRM'.
// Le da a la cuenta de pago sus límites de canales (el super admin puede cambiarlo luego). El plan
// por familia sigue definiendo IA/módulos/contactos. Devuelve null si el tipo no existe.
async function accountTypeIdForFamily(family) {
  const name = family === 'agente' ? 'Starter' : family === 'crm' ? 'CRM' : null
  if (!name) return null
  try { return (await subs.listTypes()).find(t => t.name === name)?.id || null } catch { return null }
}

// Activa/renueva la suscripción de pago de una cuenta con un plan por familia.
async function activate(accId, plan, details = {}) {
  const accountTypeId = await accountTypeIdForFamily(plan.family)
  await subs.assignSubscription(accId, { subscriptionPlanId: plan.id, planFamily: plan.family, accountTypeId, resetPeriod: true })
  await setGatewayDetails(accId, {
    gateway: details.gateway, currency: details.currency,
    amountCop: details.amountCop ?? null, amountUsd: details.amountUsd ?? null,
    stripeCustomerId: details.stripeCustomerId, stripeSubscriptionId: details.stripeSubscriptionId,
    wompiPaymentSourceId: details.wompiPaymentSourceId,
    nextChargeAt: Date.now() + 30 * DAY,
  })
}

// ── Checkout ─────────────────────────────────────────────────────────────────
// Stripe → { gateway, url } para redirigir. Wompi → cobra con la tarjeta tokenizada y activa.
async function startCheckout(accId, { planId, gateway, email, cardToken, acceptanceToken }) {
  const cfg = await loadConfig()
  const plan = await getPlan(planId)
  if (!plan || !plan.family || plan.family === 'free') throw new Error('Plan inválido')
  if (plan.isCustomContact) throw new Error('El plan a medida se contrata con ventas')
  const { rate } = await fx.getRate()
  const priceCop = plan.priceCop || 0
  const priceUsd = rate ? Math.round((priceCop / rate) * 100) / 100 : 0

  if (gateway === 'stripe') {
    if (!stripe.isEnabled(cfg.stripe)) throw new Error('Stripe no está configurado')
    const session = await stripe.createCheckoutSession(cfg.stripe, {
      accId, planId: plan.id, planName: `AVI ${plan.name}`, email,
      currency: 'usd', unitAmountMinor: Math.round(priceUsd * 100),
      successUrl: `${baseUrl()}/?billing=success`,
      cancelUrl: `${baseUrl()}/?billing=cancel`,
    })
    return { gateway: 'stripe', url: session.url }
  }

  if (gateway === 'wompi') {
    if (!wompi.isEnabled(cfg.wompi)) throw new Error('Wompi no está configurado')
    // CHECKOUT ALOJADO: se redirige a la pasarela externa de Wompi, donde el cliente paga con
    // el medio que quiera (tarjeta con 3D Secure, PSE, Nequi, Bancolombia…). Antes se cobraba
    // con un formulario de tarjeta propio sin autenticación, y el banco declinaba casi siempre.
    // El plan se activa cuando llega el webhook con la transacción aprobada.
    const link = await wompi.createPaymentLink(cfg.wompi, {
      amountInCents: Math.round(priceCop * 100),
      currency: 'COP',
      name: `AVI ${plan.name}`,
      description: `Suscripción mensual al plan ${plan.name} de AVI Asistente`,
      redirectUrl: `${baseUrl()}/?billing=wompi`,
    })
    const now = Date.now()
    await pool.query(
      `INSERT INTO platform_checkouts (id, account_id, plan_id, gateway, link_id, amount_cop, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ['pchk_' + uid(), accId, plan.id, 'wompi', link.linkId, priceCop, 'pending', now, now]
    )
    return { gateway: 'wompi', url: link.url }
  }
  throw new Error('Pasarela no soportada')
}

// ── Renovación (extiende ciclo + reinicia consumo) ────────────────────────────
async function renewPeriod(accId) {
  const now = Date.now()
  await pool.query(
    `UPDATE account_subscriptions SET status='active', grace_until=NULL,
       contact_count_current_period=0, conversation_count_current_period=0, last_alert_threshold=0,
       current_period_start=?, current_period_end=?, next_charge_at=?, updated_at=? WHERE account_id=?`,
    [now, now + 30 * DAY, now + 30 * DAY, now, accId]
  )
  require('./socket').emit(accId, 'account:updated', { accId })
}

// ── Webhook de Stripe (cuerpo crudo + firma) ──────────────────────────────────
async function handleStripeWebhook(rawBody, sigHeader) {
  const cfg = await loadConfig()
  if (!stripe.isEnabled(cfg.stripe)) return { ok: false, reason: 'stripe off' }
  if (!stripe.verifyWebhook(cfg.stripe, rawBody, sigHeader)) return { ok: false, reason: 'bad signature' }
  let event; try { event = JSON.parse(rawBody.toString('utf8')) } catch { return { ok: false } }
  const type = event?.type
  const obj = event?.data?.object || {}
  try {
    if (type === 'checkout.session.completed') {
      const accId = obj?.metadata?.accId, planId = obj?.metadata?.planId
      const plan = planId ? await getPlan(planId) : null
      if (accId && plan) await activate(accId, plan, { gateway: 'stripe', currency: (obj.currency || 'usd').toUpperCase(), stripeCustomerId: obj.customer || null, stripeSubscriptionId: obj.subscription || null })
    } else if (type === 'invoice.paid') {
      const subId = obj?.subscription
      if (subId) { const [[s]] = await pool.query('SELECT account_id FROM account_subscriptions WHERE stripe_subscription_id=?', [subId]); if (s?.account_id) await renewPeriod(s.account_id) }
    } else if (type === 'invoice.payment_failed') {
      const subId = obj?.subscription; const now = Date.now()
      if (subId) await pool.query("UPDATE account_subscriptions SET status='grace', grace_until=?, updated_at=? WHERE stripe_subscription_id=? AND status<>'grace'", [now + 5 * DAY, now, subId])
    } else if (type === 'customer.subscription.deleted') {
      const subId = obj?.id
      if (subId) { const [[s]] = await pool.query('SELECT account_id FROM account_subscriptions WHERE stripe_subscription_id=?', [subId]); if (s?.account_id) await subs.downgradeToFree(s.account_id) }
    }
  } catch (e) { console.warn('[stripe webhook]', type, e.message) }
  return { ok: true, type }
}

// ── Webhook de Wompi ──────────────────────────────────────────────────────────
// Con el checkout alojado el pago ocurre FUERA de la plataforma, así que este webhook es la
// fuente de verdad: al llegar la transacción aprobada se busca el checkout por payment_link_id
// y se activa (o renueva) la suscripción. Idempotente: un checkout ya pagado se ignora.
async function handleWompiWebhook(event) {
  const cfg = await loadConfig()
  if (!wompi.isEnabled(cfg.wompi)) return { ok: false }
  const parsed = wompi.parseEvent(cfg.wompi, event)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const now = Date.now()
  try {
    if (parsed.paymentLinkId) {
      const [[chk]] = await pool.query('SELECT * FROM platform_checkouts WHERE link_id=? LIMIT 1', [parsed.paymentLinkId])
      if (chk && chk.status !== 'approved') {
        await pool.query('UPDATE platform_checkouts SET status=?, reference=?, updated_at=? WHERE id=?',
          [parsed.status, parsed.reference || null, now, chk.id])
        if (parsed.status === 'approved') {
          const plan = await getPlan(chk.plan_id)
          if (plan) {
            const { rate } = await fx.getRate()
            const priceCop = Number(chk.amount_cop) || plan.priceCop || 0
            await activate(chk.account_id, plan, {
              gateway: 'wompi', currency: 'COP',
              amountCop: priceCop,
              amountUsd: rate ? Math.round((priceCop / rate) * 100) / 100 : null,
            })
            console.log(`[wompi webhook] plan "${plan.name}" activado para ${chk.account_id}`)
          }
        }
      }
    }
    // Sin paymentLinkId es un cobro recurrente con tarjeta guardada (cuentas antiguas):
    // `chargeWompiRenewals` ya confirma ese cobro en línea y renueva, así que aquí no se
    // hace nada (no se puede identificar la cuenta de forma fiable desde el evento).
  } catch (e) { console.warn('[wompi webhook]', e.message) }
  return { ok: true, status: parsed.status }
}

// ── Worker: cobra las renovaciones de Wompi vencidas ──────────────────────────
async function chargeWompiRenewals() {
  const cfg = await loadConfig()
  if (!wompi.isEnabled(cfg.wompi)) return
  const now = Date.now()
  const [rows] = await pool.query(
    "SELECT * FROM account_subscriptions WHERE gateway='wompi' AND wompi_payment_source_id IS NOT NULL AND next_charge_at IS NOT NULL AND next_charge_at<=? AND status IN ('active','grace') LIMIT 100",
    [now]
  )
  for (const s of rows) {
    try {
      const plan = s.subscription_plan_id ? await getPlan(s.subscription_plan_id) : null
      if (!plan) continue
      const [[acc]] = await pool.query('SELECT email FROM accounts WHERE id=?', [s.account_id])
      const reference = 'sub_' + uid() + uid()
      const r = await wompi.charge(cfg.wompi, { amountInCents: Math.round((plan.priceCop || 0) * 100), currency: 'COP', customerEmail: acc?.email || '', paymentSourceId: s.wompi_payment_source_id, reference })
      if (r.status === 'approved') await renewPeriod(s.account_id)
      // Declinado → next_charge_at sigue vencido: el worker de suscripciones abre/mantiene la
      // gracia (gateway='wompi'); tras 5 días baja a Gratuito. Se reintenta en el próximo pase.
    } catch (e) { console.warn('[wompi renew]', s.account_id, e.message) }
  }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(() => chargeWompiRenewals().catch(() => {}), 6 * 60 * 60000) // cada 6 h
  _timer.unref?.()
  setTimeout(() => chargeWompiRenewals().catch(() => {}), 60000)                     // primer pase al minuto
}

module.exports = {
  loadConfig, availability, wompiInit, startCheckout,
  handleStripeWebhook, handleWompiWebhook, chargeWompiRenewals, startWorker,
}
