'use strict'
/**
 * Facturación del DUEÑO de la cuenta (autoservicio): catálogo de planes con precio en
 * COP (base) y USD en vivo, la suscripción actual con su uso de contactos, y la tasa
 * de cambio. El checkout + cobro recurrente (Stripe/Wompi) llega en la Etapa 3.
 */
const subs = require('../services/subscriptions')
const fx = require('../services/fx')

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
    })
  } catch (err) { console.error('[billing subscription]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { getCatalog, getFx, getMySubscription }
