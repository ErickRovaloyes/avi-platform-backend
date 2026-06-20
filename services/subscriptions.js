'use strict'
/**
 * Suscripciones (Fase 1) — Tipos de Cuenta + Mensualidades + enforcement.
 *
 * Modelo:
 *   account_types        → límites de canales + reglas Demo (7d/100/30).
 *   subscription_plans   → límite de conversaciones mensuales (+ gracia).
 *   account_subscriptions→ vínculo por cuenta: tipo, plan, ciclo y consumo.
 *
 * Enforcement central:
 *   - assistantGate(accId, convId): se llama ANTES de que la IA responda. Bloquea
 *     y devuelve el mensaje correspondiente cuando: cuenta suspendida/vencida,
 *     demo vencida, demo con 100 convos, demo con 30 respuestas en la conversación,
 *     o plan mensual agotado tras el periodo de gracia.
 *   - channelGate(accId, type, used): límite de canales por tipo de cuenta.
 *   - incrementConversation(accId): suma 1 al consumo al crear una conversación.
 *   - worker: vence demos, reinicia ciclos, activa gracia/suspensión y emite alertas.
 */
const pool = require('../db')
const socket = require('./socket')
const { uid } = require('../utils')

const DAY = 24 * 60 * 60 * 1000

// ── Seed por defecto (solo si las tablas están vacías) ─────────────────────────
async function seedDefaults() {
  const now = Date.now()
  const [[{ n: typeCount }]] = await pool.query('SELECT COUNT(*) AS n FROM account_types')
  if (!typeCount) {
    const types = [
      // name,        wc, wa, test, msg, ig, isDemo, days, maxConv, maxAi, order
      ['Demo',         1,  1,  1,   0,  0,  1,      7,   100,    30,    0],
      ['Starter',      1,  1,  3,   1,  1,  0,      0,   0,      0,     1],
      ['Pro',          2,  2,  6,   2,  2,  0,      0,   0,      0,     2],
      ['Enterprise',  10, 10, 10,  10, 10,  0,      0,   0,      0,     3],
    ]
    for (const [name, wc, wa, test, msg, ig, isDemo, days, maxConv, maxAi, order] of types) {
      await pool.query(
        `INSERT INTO account_types
          (id,name,max_webchat_channels,max_whatsapp_channels,max_test_channels,max_messenger_channels,max_instagram_channels,
           is_demo,demo_days_duration,demo_max_conversations,demo_max_ai_responses_per_conversation,sort_order,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['atype_' + uid(), name, wc, wa, test, msg, ig, isDemo, days, maxConv, maxAi, order, now, now]
      )
    }
  }
  const [[{ n: planCount }]] = await pool.query('SELECT COUNT(*) AS n FROM subscription_plans')
  if (!planCount) {
    const plans = [
      // name,        monthlyLimit, isCustom, grace, order
      ['Starter',     1500,  0, 5, 0],
      ['Pro',         3000,  0, 5, 1],
      ['Expert',      5000,  0, 5, 2],
      ['Enterprise',  0,     1, 5, 3],
    ]
    for (const [name, limit, custom, grace, order] of plans) {
      await pool.query(
        `INSERT INTO subscription_plans (id,name,monthly_conversation_limit,is_custom_limit,grace_period_days,sort_order,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['plan_' + uid(), name, limit, custom, grace, order, now, now]
      )
    }
  }
}

// ── Lecturas ──────────────────────────────────────────────────────────────────
async function listTypes() {
  const [rows] = await pool.query('SELECT * FROM account_types ORDER BY sort_order, created_at')
  return rows.map(mapType)
}
async function listPlans() {
  const [rows] = await pool.query('SELECT * FROM subscription_plans ORDER BY sort_order, created_at')
  return rows.map(mapPlan)
}
const mapType = t => ({
  id: t.id, name: t.name,
  maxWebchatChannels: t.max_webchat_channels, maxWhatsappChannels: t.max_whatsapp_channels,
  maxTestChannels: t.max_test_channels, maxMessengerChannels: t.max_messenger_channels,
  maxInstagramChannels: t.max_instagram_channels,
  isDemo: !!t.is_demo, demoDaysDuration: t.demo_days_duration,
  demoMaxConversations: t.demo_max_conversations,
  demoMaxAiResponsesPerConversation: t.demo_max_ai_responses_per_conversation,
  sortOrder: t.sort_order,
})
const mapPlan = p => ({
  id: p.id, name: p.name, monthlyConversationLimit: p.monthly_conversation_limit,
  isCustomLimit: !!p.is_custom_limit, gracePeriodDays: p.grace_period_days, sortOrder: p.sort_order,
})

// Devuelve la suscripción de una cuenta con su tipo y plan resueltos (o null).
async function getSubscription(accId) {
  const [[s]] = await pool.query('SELECT * FROM account_subscriptions WHERE account_id=?', [accId])
  if (!s) return null
  const [[type]] = s.account_type_id ? await pool.query('SELECT * FROM account_types WHERE id=?', [s.account_type_id]) : [[null]]
  const [[plan]] = s.subscription_plan_id ? await pool.query('SELECT * FROM subscription_plans WHERE id=?', [s.subscription_plan_id]) : [[null]]
  return {
    id: s.id, accountId: s.account_id,
    accountTypeId: s.account_type_id, subscriptionPlanId: s.subscription_plan_id,
    customMonthlyLimit: s.custom_monthly_limit,
    conversationCount: s.conversation_count_current_period || 0,
    currentPeriodStart: s.current_period_start, currentPeriodEnd: s.current_period_end,
    graceUntil: s.grace_until, demoStartedAt: s.demo_started_at, demoExpiresAt: s.demo_expires_at,
    lastAlertThreshold: s.last_alert_threshold || 0, status: s.status || 'active',
    type: type ? mapType(type) : null, plan: plan ? mapPlan(plan) : null,
    raw: s,
  }
}

// Crea/actualiza la suscripción de una cuenta (asignación desde el SuperAdmin).
async function assignSubscription(accId, { accountTypeId, subscriptionPlanId, customMonthlyLimit }) {
  const now = Date.now()
  const [[existing]] = await pool.query('SELECT * FROM account_subscriptions WHERE account_id=?', [accId])
  // Resolver el tipo para decidir periodo/demo.
  let type = null
  if (accountTypeId) { const [[t]] = await pool.query('SELECT * FROM account_types WHERE id=?', [accountTypeId]); type = t }
  const isDemo = type ? !!type.is_demo : false
  const periodStart = existing?.current_period_start || now
  const periodEnd = existing?.current_period_end || (now + 30 * DAY)
  const demoStart = isDemo ? (existing?.demo_started_at || now) : null
  const demoExpires = isDemo ? (demoStart + (type.demo_days_duration || 7) * DAY) : null

  if (existing) {
    await pool.query(
      `UPDATE account_subscriptions SET account_type_id=?, subscription_plan_id=?, custom_monthly_limit=?,
        demo_started_at=?, demo_expires_at=?, status='active', updated_at=? WHERE account_id=?`,
      [accountTypeId || null, subscriptionPlanId || null, customMonthlyLimit ?? existing.custom_monthly_limit ?? null,
       demoStart, demoExpires, now, accId]
    )
  } else {
    await pool.query(
      `INSERT INTO account_subscriptions
        (id,account_id,account_type_id,subscription_plan_id,custom_monthly_limit,conversation_count_current_period,
         current_period_start,current_period_end,demo_started_at,demo_expires_at,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['sub_' + uid(), accId, accountTypeId || null, subscriptionPlanId || null, customMonthlyLimit ?? null, 0,
       periodStart, periodEnd, demoStart, demoExpires, 'active', now, now]
    )
  }
  socket.emit(accId, 'account:updated', { accId })
  return getSubscription(accId)
}

function effectiveMonthlyLimit(sub) {
  if (!sub?.plan) return null
  if (sub.plan.isCustomLimit) return sub.customMonthlyLimit ?? null // null = sin límite definido aún
  return sub.plan.monthlyConversationLimit || 0
}

// ── Conteo de consumo ─────────────────────────────────────────────────────────
async function incrementConversation(accId) {
  try {
    await pool.query(
      'UPDATE account_subscriptions SET conversation_count_current_period=conversation_count_current_period+1, updated_at=? WHERE account_id=?',
      [Date.now(), accId]
    )
    const sub = await getSubscription(accId)
    if (sub) await maybeAlert(sub)
  } catch { /* sin suscripción → sin límite */ }
}

// ── Gate de canales ───────────────────────────────────────────────────────────
// `used` = canales de ese tipo ya configurados en la cuenta.
async function channelGate(accId, channelType, used = 0) {
  const sub = await getSubscription(accId)
  if (!sub?.type) return { allowed: true } // sin tipo asignado → sin restricción
  const map = {
    webchat: 'maxWebchatChannels', whatsapp: 'maxWhatsappChannels', test: 'maxTestChannels',
    messenger: 'maxMessengerChannels', instagram: 'maxInstagramChannels',
  }
  const key = map[channelType]
  if (!key) return { allowed: true }
  const max = sub.type[key] ?? 0
  if (used >= max) {
    return { allowed: false, max, used, message: `Tu tipo de cuenta (${sub.type.name}) permite ${max} canal(es) de ${channelType}.` }
  }
  return { allowed: true, max, used }
}

// ── Gate del asistente (se llama antes de que la IA responda) ──────────────────
const MSG = {
  convAi: 'Has alcanzado el límite de respuestas permitido para esta conversación.',
  demoConv: 'Has alcanzado el límite de conversaciones de la cuenta Demo. Para continuar utilizando la plataforma debes adquirir un plan de pago.',
  demoExpired: 'Tu cuenta Demo ha vencido. Para continuar utilizando la plataforma debes adquirir un plan de pago.',
  suspended: 'Tu suscripción ha vencido. Para reactivar el servicio debes realizar el pago correspondiente.',
  planLimit: 'Has alcanzado el límite de conversaciones de tu plan.',
  expertLimit: 'Has alcanzado el límite de tu plan Expert. Contacta al equipo comercial de AVI Asistente para ampliar tu capacidad mediante un plan Enterprise.',
}

async function assistantGate(accId, convId) {
  const sub = await getSubscription(accId)
  if (!sub) return { allowed: true } // sin suscripción configurada → no se aplica enforcement
  const now = Date.now()

  // Cuenta suspendida/vencida (cualquier tipo)
  if (sub.status === 'suspended' || sub.status === 'expired') {
    return { allowed: false, message: sub.type?.isDemo ? MSG.demoExpired : MSG.suspended }
  }

  // ── Reglas Demo ──
  if (sub.type?.isDemo) {
    if (sub.demoExpiresAt && now > sub.demoExpiresAt) {
      return { allowed: false, message: MSG.demoExpired, suspend: true }
    }
    // 30 respuestas de IA por conversación
    const maxAi = sub.type.demoMaxAiResponsesPerConversation || 0
    if (maxAi > 0 && convId) {
      const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND sender='ai'", [convId])
      if (n >= maxAi) return { allowed: false, message: MSG.convAi, closeConv: true }
    }
    // 100 conversaciones totales
    const maxConv = sub.type.demoMaxConversations || 0
    if (maxConv > 0 && sub.conversationCount >= maxConv) {
      return { allowed: false, message: MSG.demoConv }
    }
    return { allowed: true }
  }

  // ── Planes de pago ──
  const limit = effectiveMonthlyLimit(sub)
  // Enterprise / límite no definido → sin bloqueo (solo alertas)
  if (limit == null || limit <= 0) return { allowed: true }
  if (sub.conversationCount < limit) return { allowed: true }

  // Llegó al límite mensual → lógica de gracia
  const graceDays = sub.plan?.gracePeriodDays ?? 5
  const isExpert = (sub.plan?.name || '').toLowerCase() === 'expert'
  if (!sub.graceUntil) {
    // Iniciar gracia y permitir
    const until = now + graceDays * DAY
    await pool.query("UPDATE account_subscriptions SET status='grace', grace_until=?, updated_at=? WHERE account_id=?", [until, now, accId])
    socket.emit(accId, 'subscription:alert', { accId, kind: 'grace', graceUntil: until })
    return { allowed: true, grace: true }
  }
  if (now < sub.graceUntil) return { allowed: true, grace: true } // gracia activa
  // Gracia vencida → suspender y bloquear
  await pool.query("UPDATE account_subscriptions SET status='suspended', updated_at=? WHERE account_id=?", [now, accId])
  socket.emit(accId, 'subscription:alert', { accId, kind: 'suspended' })
  return { allowed: false, message: isExpert ? MSG.expertLimit : MSG.planLimit }
}

// Marca una conversación como cerrada por límite (no se vuelve a responder).
async function closeConversation(accId, convId) {
  try {
    const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=?', [convId])
    const lv = (() => { try { return JSON.parse(c?.local_vars || '{}') } catch { return {} } })()
    lv._limitClosed = true
    await pool.query('UPDATE conversations SET local_vars=?, ai_enabled=0 WHERE id=?', [JSON.stringify(lv), convId])
    socket.emit(accId, 'convos:updated', { accId })
  } catch { /* no crítico */ }
}

// ── Alertas de consumo 80/90/100% ──────────────────────────────────────────────
async function maybeAlert(sub) {
  const limit = effectiveMonthlyLimit(sub)
  if (!limit || limit <= 0) return
  const pct = Math.floor((sub.conversationCount / limit) * 100)
  let threshold = 0
  if (pct >= 100) threshold = 100
  else if (pct >= 90) threshold = 90
  else if (pct >= 80) threshold = 80
  if (threshold > (sub.lastAlertThreshold || 0)) {
    await pool.query('UPDATE account_subscriptions SET last_alert_threshold=? WHERE account_id=?', [threshold, sub.accountId])
    socket.emit(sub.accountId, 'subscription:alert', { accId: sub.accountId, kind: 'consumption', threshold, pct })
  }
}

// ── Worker: vencimientos, reinicios, gracia/suspensión ─────────────────────────
async function tick() {
  const now = Date.now()
  try {
    const [subs] = await pool.query('SELECT * FROM account_subscriptions')
    for (const s of subs) {
      // 1) Demo vencida → suspender la cuenta
      if (s.demo_expires_at && now > s.demo_expires_at && s.status !== 'expired' && s.status !== 'suspended') {
        await pool.query("UPDATE account_subscriptions SET status='expired', updated_at=? WHERE id=?", [now, s.id])
        await pool.query("UPDATE accounts SET status='suspended' WHERE id=?", [s.account_id]).catch(() => {})
        socket.emit(s.account_id, 'subscription:alert', { accId: s.account_id, kind: 'demo_expired' })
        continue
      }
      // 2) Gracia vencida → suspender
      if (s.grace_until && now > s.grace_until && s.status === 'grace') {
        await pool.query("UPDATE account_subscriptions SET status='suspended', updated_at=? WHERE id=?", [now, s.id])
        socket.emit(s.account_id, 'subscription:alert', { accId: s.account_id, kind: 'suspended' })
        continue
      }
      // 3) Reinicio del ciclo mensual (no demo)
      if (s.current_period_end && now > s.current_period_end) {
        await pool.query(
          `UPDATE account_subscriptions SET conversation_count_current_period=0, last_alert_threshold=0,
            current_period_start=?, current_period_end=?, grace_until=NULL,
            status=CASE WHEN status='suspended' THEN status ELSE 'active' END, updated_at=? WHERE id=?`,
          [now, now + 30 * DAY, now, s.id]
        )
      }
    }
  } catch (e) { console.warn('[subscriptions tick]', e.message) }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(tick, 60 * 60 * 1000) // cada hora
  _timer.unref?.()
  setTimeout(() => tick().catch(() => {}), 12000) // primer pase a los 12s
}

module.exports = {
  seedDefaults, listTypes, listPlans, getSubscription, assignSubscription,
  effectiveMonthlyLimit, incrementConversation, channelGate, assistantGate,
  closeConversation, tick, startWorker, mapType, mapPlan,
}
