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
const { uid, parseJ } = require('../utils')

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
  // Tipo "CRM" (idempotente, también en instalaciones ya existentes): solo da
  // acceso a los módulos CRM, Canales y Bandeja. Requiere la columna modules.
  try {
    const [[{ n: crmCount }]] = await pool.query("SELECT COUNT(*) AS n FROM account_types WHERE name='CRM'")
    if (!crmCount) {
      await pool.query(
        `INSERT INTO account_types
          (id,name,max_webchat_channels,max_whatsapp_channels,max_test_channels,max_messenger_channels,max_instagram_channels,
           is_demo,demo_days_duration,demo_max_conversations,demo_max_ai_responses_per_conversation,sort_order,modules,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['atype_' + uid(), 'CRM', 1, 1, 1, 1, 1, 0, 0, 0, 0, 5, JSON.stringify(['crm', 'channels', 'inbox']), now, now]
      )
    }
  } catch (e) { /* columna modules aún no migrada: se creará en el próximo arranque */ }

  // Planes por FAMILIA (CRM/Agente) escalados por contactos + Gratuito. Precio base en
  // COP (el USD se calcula con la tasa viva). Idempotente: solo si no hay ninguno.
  try {
    const [[{ n: famCount }]] = await pool.query('SELECT COUNT(*) AS n FROM subscription_plans WHERE family IS NOT NULL')
    if (!famCount) {
      // `contactLimit` significa cosas distintas según la familia:
      //   · crm/free → contactos de CRM (al agotarse se bloquea ESCRIBIR)
      //   · agente   → no aplica; su tope es `aiContactLimit` (chats de IA)
      // Los planes CRM llevan IA incluida como muestra: 100 contactos al mes.
      const fam = [
        // family,   name,             contactLimit, priceCop,  aiLimit, isCustom, order
        ['free',    'Gratuito',          100,          0,        100,     0,        0],
        ['agente',  'Agente 400',        0,            350000,   400,     0,        10],
        ['agente',  'Agente 1.500',      0,            600000,   1500,    0,        11],
        ['agente',  'Agente 3.000',      0,            720000,   3000,    0,        12],
        ['agente',  'Agente 5.000',      0,            1000000,  5000,    0,        13],
        ['agente',  'Agente CUSTOM',     0,            0,        0,       1,        14],
        ['crm',     'CRM 1.000',         1000,         90000,    100,     0,        20],
        ['crm',     'CRM 3.000',         3000,         120000,   100,     0,        21],
        ['crm',     'CRM 10.000',        10000,        150000,   100,     0,        22],
        ['crm',     'CRM Ilimitado',     0,            180000,   100,     0,        23],
      ]
      for (const [family, name, contactLimit, priceCop, aiLimit, isCustom, order] of fam) {
        await pool.query(
          `INSERT INTO subscription_plans
             (id,name,family,contact_limit,ai_contact_limit,price_cop,ai_enabled,is_custom_contact,
              monthly_conversation_limit,is_custom_limit,grace_period_days,monthly_price,sort_order,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['plan_' + uid(), name, family, contactLimit, aiLimit, priceCop, 1, isCustom, 0, 0, 5, 0, order, now, now]
        )
      }
    }
  } catch (e) { /* columnas family aún no migradas: se seedean en el próximo arranque */ }

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
  cmsStorageMb: t.cms_storage_mb != null ? t.cms_storage_mb : 500,
  sortOrder: t.sort_order,
  // Preset de módulos del tipo (null = todos). Espejo en services/modules.js.
  modules: parseJ(t.modules, null),
})
const mapPlan = p => ({
  id: p.id, name: p.name, monthlyConversationLimit: p.monthly_conversation_limit,
  isCustomLimit: !!p.is_custom_limit, gracePeriodDays: p.grace_period_days, sortOrder: p.sort_order,
  monthlyPrice: p.monthly_price != null ? Number(p.monthly_price) : 0,
  // Planes por familia escalados por contactos (COP base).
  family: p.family || null,
  contactLimit: p.contact_limit != null ? Number(p.contact_limit) : 0,   // 0 = ilimitado
  // Tope de contactos con IA. 0 = el plan no fija uno propio y se usa el de la familia.
  aiContactLimit: p.ai_contact_limit != null ? Number(p.ai_contact_limit) : 0,
  priceCop: p.price_cop != null ? Number(p.price_cop) : 0,
  aiEnabled: p.ai_enabled == null ? true : !!p.ai_enabled,
  modules: parseJ(p.modules, null),
  isCustomContact: !!p.is_custom_contact,
})

// ── Presets de módulos por familia (espejo de services/modules.js) ─────────────
const ALL_MODULES       = ['inbox', 'crm', 'channels', 'campaigns', 'flows', 'ai_agents', 'knowledge', 'calendars', 'metrics', 'teamchat']
// Los planes CRM incluyen IA (100 contactos al mes), así que necesitan `ai_agents` y
// `knowledge`: sin ellos podrían usar el asistente pero no escribir su prompt ni subir
// conocimiento, y solo un superadmin podría ajustarlo. Antes se excluían porque estos
// planes no tenían IA en absoluto.
const CRM_MODULES       = ALL_MODULES
const CRM_BASIC_MODULES = ['inbox', 'crm', 'channels']
const FAMILY_MODULES    = { agente: ALL_MODULES, crm: CRM_MODULES }
const MODULE_SETS       = { all: ALL_MODULES, crm: CRM_MODULES, crm_basic: CRM_BASIC_MODULES }

// Límite de conversaciones mensuales del Plan Gratuito cuando el tipo no define otro.
const FREE_CONVERSATION_LIMIT = 100

// ── Los DOS topes de contactos ────────────────────────────────────────────────
// Un contacto de CRM y un contacto atendido por la IA no son lo mismo y no se agotan al
// mismo ritmo: un plan CRM vende miles de contactos de CRM pero solo una MUESTRA de IA.
// Por eso hay dos contadores y dos consecuencias distintas al llegar al tope:
//
//   · contactos de CRM agotados  → se bloquea ESCRIBIR desde la plataforma (sendGate).
//     Los mensajes del cliente siguen entrando y todo se sigue viendo.
//   · contactos con IA agotados  → se calla el BOT (assistantGate). El asesor humano
//     puede seguir respondiendo con normalidad.
//
// Un plan Agente invierte el reparto: contactos de CRM ilimitados, y el número del plan
// (400/1.500/3.000/5.000) pasa a ser su tope de chats de IA.
const AI_CONTACT_LIMIT = 100     // planes CRM y Gratuito/Demo
const AI_MSGS_PER_CONV = 30      // tope de respuestas de IA por conversación

// Estado del Plan Gratuito/Demo. Acceso completo a los módulos; los topes son 100 contactos
// de CRM, 100 contactos con IA y 30 mensajes de IA por conversación.
function freeState(sub) {
  const limit = Number(sub?.type?.demoMaxConversations) || FREE_CONVERSATION_LIMIT
  return {
    modules: null,                    // null = sin recorte de módulos (acceso completo)
    aiEnabled: true,
    contactLimit: limit,              // contactos de CRM → bloquea escribir
    aiContactLimit: AI_CONTACT_LIMIT, // contactos con IA → calla el bot
    aiMsgsPerConv: AI_MSGS_PER_CONV,
    conversationLimit: limit,
    hardBlock: true,
  }
}

// Estado efectivo del plan: { family, modules, aiEnabled, contactLimit, aiContactLimit,
// aiMsgsPerConv, hardBlock, softLimit }. Un límite en 0 significa ILIMITADO.
// modules=null → no forzar (compat con planes viejos sin familia).
function effectivePlanState(sub) {
  const family = sub?.planFamily || sub?.plan?.family || null
  if (family === 'free' || (!family && sub?.freeStartedAt)) {
    const st = freeState(sub); return { family: 'free', ...st, softLimit: false }
  }
  if (family === 'agente') {
    // Agente: lo que se vende es capacidad de IA. El número del plan es el tope de chats
    // de IA; los contactos de CRM son ilimitados y NUNCA bloquean una conversación.
    // Tampoco hay corte de 30 mensajes por chat: la IA conversa sin límite.
    return {
      family, modules: ALL_MODULES, aiEnabled: true,
      contactLimit: 0,                                                    // CRM ilimitado
      aiContactLimit: sub?.plan?.aiContactLimit || sub?.plan?.contactLimit || 0,
      aiMsgsPerConv: 0,                                                   // sin corte por chat
      hardBlock: true, softLimit: false,
    }
  }
  if (family === 'crm') {
    // CRM: el tope del plan son contactos de CRM y sí bloquea (escribir, no ver).
    // La IA viene incluida como muestra: 100 contactos y 30 mensajes por conversación.
    return {
      family, modules: CRM_MODULES, aiEnabled: true,
      contactLimit: sub?.plan?.contactLimit ?? 0,
      aiContactLimit: sub?.plan?.aiContactLimit || AI_CONTACT_LIMIT,
      aiMsgsPerConv: AI_MSGS_PER_CONV,
      hardBlock: true, softLimit: false,
    }
  }
  return { family: null, modules: null, aiEnabled: true, contactLimit: 0, aiContactLimit: 0, aiMsgsPerConv: 0, hardBlock: false, softLimit: false }
}

// Devuelve la suscripción de una cuenta con su tipo y plan resueltos (o null).
/**
 * La cuenta de la que salen el plan y los límites.
 *
 * Un entorno de pruebas no tiene suscripción propia: hereda la de su cuenta real. Si no, se
 * quedaría en el plan gratuito y no serviría para probar —las funciones que se quieren ensayar
 * son justo las que da el plan de pago—. Devuelve el id de la cuenta real, o el mismo si no es
 * un entorno de pruebas.
 */
async function cuentaDeFacturacion(accId) {
  try {
    const [[a]] = await pool.query('SELECT sandbox_of FROM accounts WHERE id=?', [accId])
    return a?.sandbox_of || accId
  } catch { return accId }
}

async function getSubscription(accId) {
  // El entorno de pruebas lee la suscripción de su cuenta real: mismo plan, mismos límites,
  // mismas funciones. Probar con un plan distinto al de producción no prueba nada.
  const idFacturacion = await cuentaDeFacturacion(accId)
  const [[s]] = await pool.query('SELECT * FROM account_subscriptions WHERE account_id=?', [idFacturacion])
  if (!s) return null
  const [[type]] = s.account_type_id ? await pool.query('SELECT * FROM account_types WHERE id=?', [s.account_type_id]) : [[null]]
  const [[plan]] = s.subscription_plan_id ? await pool.query('SELECT * FROM subscription_plans WHERE id=?', [s.subscription_plan_id]) : [[null]]
  return {
    id: s.id, accountId: s.account_id,
    accountTypeId: s.account_type_id, subscriptionPlanId: s.subscription_plan_id,
    customMonthlyLimit: s.custom_monthly_limit,
    conversationCount: s.conversation_count_current_period || 0,
    contactCount: s.contact_count_current_period || 0,
    aiContactCount: s.ai_contact_count_current_period || 0,
    currentPeriodStart: s.current_period_start, currentPeriodEnd: s.current_period_end,
    graceUntil: s.grace_until, demoStartedAt: s.demo_started_at, demoExpiresAt: s.demo_expires_at,
    lastAlertThreshold: s.last_alert_threshold || 0, status: s.status || 'active',
    // Planes por familia + cobro recurrente.
    planFamily: s.plan_family || null,
    freeStartedAt: s.free_started_at || null, freePhase: s.free_phase || null,
    gateway: s.gateway || null, currency: s.currency || null,
    nextChargeAt: s.next_charge_at || null,
    chargeAmountCop: s.charge_amount_cop != null ? Number(s.charge_amount_cop) : null,
    chargeAmountUsd: s.charge_amount_usd != null ? Number(s.charge_amount_usd) : null,
    type: type ? mapType(type) : null, plan: plan ? mapPlan(plan) : null,
    raw: s,
  }
}

// Crea/actualiza la suscripción de una cuenta (SuperAdmin o autoservicio/webhook).
// `planFamily` puede venir explícito (p. ej. 'free' en el onboarding); si no, se
// deriva del plan elegido. Al CAMBIAR de familia se reinicia el ciclo y el consumo.
async function assignSubscription(accId, { accountTypeId, subscriptionPlanId, customMonthlyLimit, planFamily: familyArg, resetPeriod } = {}) {
  const now = Date.now()
  const [[existing]] = await pool.query('SELECT * FROM account_subscriptions WHERE account_id=?', [accId])
  // Resolver el tipo para decidir periodo/demo.
  let type = null
  if (accountTypeId) { const [[t]] = await pool.query('SELECT * FROM account_types WHERE id=?', [accountTypeId]); type = t }
  const isDemo = type ? !!type.is_demo : false
  // Familia del plan (por el plan elegido o el arg explícito).
  let plan = null
  if (subscriptionPlanId) { const [[p]] = await pool.query('SELECT * FROM subscription_plans WHERE id=?', [subscriptionPlanId]); plan = p }
  const planFamily = familyArg || plan?.family || null
  const isFamilyPlan = !!planFamily
  const isFree = planFamily === 'free'

  const familyChanged = isFamilyPlan && (existing?.plan_family || null) !== planFamily
  const resetCycle = !!(resetPeriod || familyChanged || !existing)

  const periodStart = resetCycle ? now : (existing?.current_period_start || now)
  const periodEnd   = resetCycle ? (now + 30 * DAY) : (existing?.current_period_end || (now + 30 * DAY))
  // Un plan por familia 'free' NO usa el vencimiento a 7 días del tipo Demo: las 3 etapas
  // (por free_started_at) reemplazan al contador. Solo un tipo Demo "puro" fija demo_expires_at.
  const demoStart   = (isDemo && !isFree) ? (existing?.demo_started_at || now) : null
  const demoExpires = (isDemo && !isFree) ? (demoStart + (type.demo_days_duration || 7) * DAY) : null
  const stayFree    = isFree && existing?.plan_family === 'free'
  const freeStarted = isFree ? (stayFree ? (existing?.free_started_at || now) : now) : null
  const freePhase   = isFree ? (stayFree ? (existing?.free_phase || null) : null) : null
  const nextCharge  = (isFamilyPlan && !isFree) ? periodEnd : null
  const rc = resetCycle ? 1 : 0

  if (existing) {
    await pool.query(
      `UPDATE account_subscriptions SET account_type_id=?, subscription_plan_id=?, custom_monthly_limit=?,
        plan_family=?, free_started_at=?, free_phase=?, next_charge_at=?,
        demo_started_at=?, demo_expires_at=?, current_period_start=?, current_period_end=?,
        contact_count_current_period=IF(?,0,contact_count_current_period),
        ai_contact_count_current_period=IF(?,0,ai_contact_count_current_period),
        last_alert_threshold=IF(?,0,last_alert_threshold),
        grace_until=IF(?,NULL,grace_until),
        status='active', updated_at=? WHERE account_id=?`,
      [accountTypeId || null, subscriptionPlanId || null, customMonthlyLimit ?? existing.custom_monthly_limit ?? null,
       planFamily, freeStarted, freePhase, nextCharge,
       // 4 × rc: contactos CRM, contactos IA, umbral de alerta y gracia se reinician juntos.
       demoStart, demoExpires, periodStart, periodEnd, rc, rc, rc, rc, now, accId]
    )
  } else {
    await pool.query(
      `INSERT INTO account_subscriptions
        (id,account_id,account_type_id,subscription_plan_id,custom_monthly_limit,conversation_count_current_period,contact_count_current_period,
         current_period_start,current_period_end,demo_started_at,demo_expires_at,plan_family,free_started_at,free_phase,next_charge_at,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['sub_' + uid(), accId, accountTypeId || null, subscriptionPlanId || null, customMonthlyLimit ?? null, 0, 0,
       periodStart, periodEnd, demoStart, demoExpires, planFamily, freeStarted, freePhase, nextCharge, 'active', now, now]
    )
  }
  // Conversión Demo → Pago: si la cuenta venía de un tipo Demo y ahora pasa a un
  // tipo de pago, marcamos su registro Demo como 'converted' (para el comercial).
  try {
    if (existing?.account_type_id && !isDemo) {
      const [[prevType]] = await pool.query('SELECT is_demo FROM account_types WHERE id=?', [existing.account_type_id])
      if (prevType?.is_demo) {
        await pool.query("UPDATE demo_registrations SET status='converted' WHERE account_id=? AND result IN ('created','created_override')", [accId])
      }
    }
  } catch { /* no crítico */ }
  // Al pasar a un tipo de PAGO se DESBLOQUEA la IA en los chats que la Demo había
  // desactivado por el límite de respuestas (se limpia el motivo). El asesor ya
  // puede reactivar la IA en esos chats.
  if (!isDemo) {
    try { await pool.query("UPDATE conversations SET ai_disabled_reason=NULL WHERE account_id=? AND ai_disabled_reason='ai_per_conv_limit'", [accId]) } catch { /* no crítico */ }
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
/**
 * Suma una conversación al consumo del ciclo.
 *
 * A propósito NO resuelve la cuenta de facturación: se escribe con el id que llega. Un entorno
 * de pruebas no tiene fila en `account_subscriptions`, así que esto no afecta a ninguna y el
 * Resuelve la cuenta de facturación: lo consumido en el entorno de pruebas cuenta como consumo
 * REAL. El entorno no tiene fila propia, así que sin resolver no se contaría nada y las pruebas
 * saldrían gratis.
 */
async function incrementConversation(accId) {
  try {
    accId = await cuentaDeFacturacion(accId)
    await pool.query(
      'UPDATE account_subscriptions SET conversation_count_current_period=conversation_count_current_period+1, updated_at=? WHERE account_id=?',
      [Date.now(), accId]
    )
    const sub = await getSubscription(accId)
    if (sub) await maybeAlert(sub)
  } catch { /* sin suscripción → sin límite */ }
}

// ── Consumo por CONTACTOS (contactos distintos con actividad en el ciclo) ──────
// Se llama al entrar un mensaje de un contacto. Idempotente por (cuenta, contacto,
// ciclo): solo el PRIMER mensaje del contacto en el ciclo suma 1.
async function markContactActive(accId, contactId) {
  if (!accId || !contactId) return
  try {
    // Los contactos del entorno de pruebas cuentan contra el cupo de la cuenta real.
    accId = await cuentaDeFacturacion(accId)
    const [[s]] = await pool.query('SELECT current_period_start FROM account_subscriptions WHERE account_id=?', [accId])
    if (!s) return
    const periodStart = s.current_period_start || 0
    const [r] = await pool.query(
      'INSERT IGNORE INTO subscription_contact_activity (account_id, contact_id, period_start, created_at) VALUES (?,?,?,?)',
      [accId, contactId, periodStart, Date.now()]
    )
    if ((r?.affectedRows || 0) > 0) {
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM subscription_contact_activity WHERE account_id=? AND period_start=?', [accId, periodStart])
      await pool.query('UPDATE account_subscriptions SET contact_count_current_period=?, updated_at=? WHERE account_id=?', [n, Date.now(), accId])
      const sub = await getSubscription(accId)
      if (sub) await maybeAlertContacts(sub)
    }
  } catch { /* sin suscripción → sin conteo */ }
}

// ── Consumo por contactos ATENDIDOS POR LA IA ─────────────────────────────────
// Devuelve si este contacto puede ser atendido por la IA, contándolo si es nuevo.
//
// 🔴 El orden importa. Primero se mira si el contacto YA estaba contado en el ciclo y solo
// después se compara con el tope. Al revés, el contacto que ocupa la última plaza se
// bloquearía a sí mismo en su segundo mensaje: entraría contado, y en la siguiente vuelta
// el contador ya estaría en el tope. La regla es:
//   · contacto ya contado  → pasa siempre, aunque el cupo esté lleno;
//   · contacto nuevo con el cupo lleno → se bloquea y NO se cuenta (no gasta plaza).
async function claimAiContact(accId, contactId, limit) {
  if (!accId || !contactId) return { allowed: true, counted: false }
  // Igual que los demás contadores: el entorno de pruebas consume del cupo de la cuenta real.
  accId = await cuentaDeFacturacion(accId)
  const [[s]] = await pool.query('SELECT current_period_start FROM account_subscriptions WHERE account_id=?', [accId])
  if (!s) return { allowed: true, counted: false }
  const periodStart = s.current_period_start || 0

  const [[seen]] = await pool.query(
    'SELECT 1 AS x FROM subscription_ai_contact_activity WHERE account_id=? AND contact_id=? AND period_start=?',
    [accId, contactId, periodStart]
  )
  if (seen) return { allowed: true, counted: false }          // ya tenía plaza

  if (limit > 0) {
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM subscription_ai_contact_activity WHERE account_id=? AND period_start=?',
      [accId, periodStart]
    )
    if (n >= limit) return { allowed: false, counted: false, used: n, limit }  // cupo lleno
  }

  const [r] = await pool.query(
    'INSERT IGNORE INTO subscription_ai_contact_activity (account_id, contact_id, period_start, created_at) VALUES (?,?,?,?)',
    [accId, contactId, periodStart, Date.now()]
  )
  if ((r?.affectedRows || 0) > 0) {
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM subscription_ai_contact_activity WHERE account_id=? AND period_start=?',
      [accId, periodStart]
    )
    await pool.query('UPDATE account_subscriptions SET ai_contact_count_current_period=?, updated_at=? WHERE account_id=?',
      [n, Date.now(), accId])
  }
  return { allowed: true, counted: true }
}

// Alertas de consumo de contactos 80/90/100% (reusa last_alert_threshold).
async function maybeAlertContacts(sub) {
  const st = effectivePlanState(sub)
  const limit = st.contactLimit
  if (!limit || limit <= 0) return
  const pct = Math.floor((sub.contactCount / limit) * 100)
  let threshold = 0
  if (pct >= 100) threshold = 100; else if (pct >= 90) threshold = 90; else if (pct >= 80) threshold = 80
  if (threshold > (sub.lastAlertThreshold || 0)) {
    await pool.query('UPDATE account_subscriptions SET last_alert_threshold=? WHERE account_id=?', [threshold, sub.accountId])
    socket.emit(sub.accountId, 'subscription:alert', { accId: sub.accountId, kind: 'contact_consumption', threshold, pct, family: st.family })
  }
}

// Baja una cuenta al Plan Gratuito (acceso completo, limitado a N conversaciones al mes).
// Limpia los datos de cobro recurrente y abre un ciclo nuevo con el contador a cero.
async function downgradeToFree(accId) {
  const now = Date.now()
  await pool.query(
    `UPDATE account_subscriptions SET plan_family='free', subscription_plan_id=NULL, free_started_at=?, free_phase=NULL,
       gateway=NULL, stripe_subscription_id=NULL, wompi_payment_source_id=NULL, next_charge_at=NULL,
       conversation_count_current_period=0, contact_count_current_period=0, ai_contact_count_current_period=0, last_alert_threshold=0, grace_until=NULL,
       current_period_start=?, current_period_end=?, status='active', updated_at=? WHERE account_id=?`,
    [now, now, now + 30 * DAY, now, accId]
  )
  socket.emit(accId, 'account:updated', { accId })
  socket.emit(accId, 'subscription:alert', { accId, kind: 'downgraded_free' })
}

// Al llegar al tope de contactos (planes de pago con bloqueo duro: Agente):
// abre 5 días de gracia; vencida, baja al Plan Gratuito.
async function applyContactGrace(sub, now) {
  const accId = sub.accountId
  const graceDays = sub.plan?.gracePeriodDays ?? 5
  if (!sub.graceUntil) {
    const until = now + graceDays * DAY
    await pool.query("UPDATE account_subscriptions SET status='grace', grace_until=?, updated_at=? WHERE account_id=?", [until, now, accId])
    socket.emit(accId, 'subscription:alert', { accId, kind: 'contact_grace', graceUntil: until })
    return { allowed: true, grace: true }
  }
  if (now < sub.graceUntil) return { allowed: true, grace: true }
  await downgradeToFree(accId)
  return { allowed: false, disableAi: true, reason: 'contact_limit' }
}

// ── Gate de canales ───────────────────────────────────────────────────────────
// `used` = canales de ese tipo ya configurados en la cuenta.
const CHANNEL_TYPES = ['webchat', 'test', 'whatsapp', 'messenger', 'instagram']
const TYPE_COLUMN = {
  webchat: 'maxWebchatChannels', test: 'maxTestChannels', whatsapp: 'maxWhatsappChannels',
  messenger: 'maxMessengerChannels', instagram: 'maxInstagramChannels',
}
// Límites de una cuenta SIN tipo asignado. Espejo del `free` de frontend/src/lib/storage.js.
const FREE_CHANNEL_LIMITS = { webchat: 1, test: 1, whatsapp: 0, messenger: 0, instagram: 0 }

/**
 * Límites de canales efectivos de una cuenta: { webchat, test, whatsapp, messenger, instagram }.
 * -1 = ilimitado.
 *
 * ES LA ÚNICA FUENTE DE VERDAD. Antes había dos que no se hablaban: la interfaz los calculaba
 * del campo legado `accounts.plan` y el servidor del tipo de cuenta. Como asignar un tipo NO
 * toca `accounts.plan` (que en una cuenta nueva vale 'free', con 0 de WhatsApp), la interfaz
 * bloqueaba canales que el tipo sí permitía. Ahora se resuelve aquí y el frontend solo lee.
 *
 * Orden de precedencia:
 *   1. `accounts.channel_limits_override` — escotilla por cuenta del superadmin. Antes se
 *      guardaba, se mostraba y el servidor NO la miraba: un override no hacía nada aquí.
 *   2. El tipo de cuenta asignado (account_types.max_*_channels).
 *   3. Sin tipo → los del plan Gratuito de platform_settings (o FREE_CHANNEL_LIMITS).
 */
async function channelLimitsFor(accId) {
  let base = null
  try {
    const sub = await getSubscription(accId)
    if (sub?.type) {
      base = {}
      for (const t of CHANNEL_TYPES) base[t] = sub.type[TYPE_COLUMN[t]] ?? 0
    }
  } catch { /* sin suscripción → se cae al Gratuito */ }

  if (!base) {
    let pf = null
    try { const [[r]] = await pool.query('SELECT channel_limits FROM platform_settings WHERE id=1'); pf = parseJ(r?.channel_limits, null) } catch {}
    base = { ...FREE_CHANNEL_LIMITS, ...(pf?.free || {}) }
  }

  let override = {}
  try {
    const [[a]] = await pool.query('SELECT channel_limits_override FROM accounts WHERE id=?', [accId])
    override = parseJ(a?.channel_limits_override, {}) || {}
  } catch {}

  const out = {}
  // `??` y no `||`: un override en 0 significa "ninguno permitido", no "sin definir".
  for (const t of CHANNEL_TYPES) out[t] = override[t] ?? base[t] ?? 0
  return out
}

async function channelGate(accId, channelType, used = 0) {
  if (!CHANNEL_TYPES.includes(channelType)) return { allowed: true }
  const limits = await channelLimitsFor(accId)
  const max = limits[channelType] ?? 0
  if (max === -1) return { allowed: true, max, used }   // ilimitado
  if (used >= max) {
    return {
      allowed: false, max, used,
      message: max === 0
        ? `Tu plan no incluye canales de ${channelType}. Contacta con el equipo comercial para habilitarlo.`
        : `Tu plan permite ${max} canal(es) de ${channelType} y ya tienes ${used}.`,
    }
  }
  return { allowed: true, max, used }
}

// ── Gate de ESCRITURA (se llama antes de entregar un mensaje manual) ──────────
// Es el tope de contactos de CRM, y su consecuencia es distinta a la de la IA: aquí no se
// calla al bot, se corta la capacidad de REDACTAR desde AVI. Todo lo demás sigue igual —
// los mensajes del cliente entran, las conversaciones se leen, y si el dueño responde
// desde el WhatsApp de su propio teléfono ese mensaje se sincroniza como siempre.
//
// Vive en el servidor a propósito: la web y la app móvil comparten esta misma ruta de
// entrega, así que un tope aplicado solo en la interfaz se esquivaría abriendo la app.
async function sendGate(accId) {
  const sub = await getSubscription(accId)
  if (!sub) return { allowed: true }
  const st = effectivePlanState(sub)
  // Los planes Agente no tienen tope de contactos de CRM: nunca se les bloquea escribir.
  if (!st.hardBlock || !st.contactLimit || st.contactLimit <= 0) return { allowed: true }
  if (sub.contactCount < st.contactLimit) return { allowed: true }
  return {
    allowed: false, reason: 'crm_contact_limit',
    used: sub.contactCount, limit: st.contactLimit,
    message: `Has alcanzado los ${st.contactLimit} contactos de tu plan este ciclo, así que no puedes escribir desde la plataforma. Puedes seguir viendo las conversaciones y los mensajes que lleguen. Amplía tu plan o espera al siguiente ciclo de facturación para volver a responder.`,
  }
}

// Apaga la IA en una conversación dejando el motivo (franja visible solo para admins).
async function disableAiInConv(accId, convId, reason) {
  if (!convId) return
  try {
    await pool.query('UPDATE conversations SET ai_enabled=0, ai_disabled_reason=? WHERE id=?', [reason, convId])
    socket.emit(accId, 'convos:updated', { accId })
  } catch { /* el side-effect no debe tumbar el gate */ }
}

// El contacto de una conversación vive en `local_vars.contact_id`, igual que lo leen
// conversations.controller.js y flow/store.js para el contador de contactos de CRM.
async function contactIdOf(convId) {
  if (!convId) return null
  try {
    const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=?', [convId])
    return parseJ(c?.local_vars, {})?.contact_id || null
  } catch { return null }
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

  // ── Planes por familia (CRM / Agente / Gratuito) ──
  const family = sub.planFamily || sub.plan?.family
  if (family) {
    const st = effectivePlanState(sub)
    if (!st.aiEnabled) return { allowed: false, disableAi: true, reason: 'plan_no_ai' }

    // 1) Tope de respuestas de IA por conversación (CRM y Gratuito; los Agente no lo tienen).
    //    No se avisa al contacto: se apaga la IA en ese chat y se deja el motivo para que
    //    los administradores lo vean. El asesor humano continúa sin problema.
    if (st.aiMsgsPerConv > 0 && convId) {
      const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND sender='ai'", [convId])
      if (n >= st.aiMsgsPerConv) {
        await disableAiInConv(accId, convId, 'ai_per_conv_limit')
        return { allowed: false, disableAi: true, reason: 'ai_per_conv_limit', max: st.aiMsgsPerConv }
      }
    }

    // 2) Tope de CONTACTOS ATENDIDOS POR LA IA.
    //    En Agente es el tope del plan y da derecho a días de gracia (se sigue respondiendo
    //    mientras duren). En CRM/Gratuito es la muestra de 100 y corta en seco: el bot calla,
    //    pero la cuenta sigue funcionando y el asesor responde a mano.
    if (st.aiContactLimit > 0) {
      const contactId = await contactIdOf(convId)
      if (contactId) {
        const claim = await claimAiContact(accId, contactId, st.aiContactLimit)
        if (!claim.allowed) {
          if (family === 'agente') return applyContactGrace(sub, now)
          await disableAiInConv(accId, convId, 'ai_contact_limit')
          return { allowed: false, disableAi: true, reason: 'ai_contact_limit', max: st.aiContactLimit }
        }
      }
    }

    // 3) Gratuito: tope de conversaciones mensuales.
    if (st.conversationLimit > 0 && sub.conversationCount >= st.conversationLimit) {
      return { allowed: false, message: MSG.demoConv }
    }
    return { allowed: true }
  }

  // ── Reglas Demo ──
  if (sub.type?.isDemo) {
    if (sub.demoExpiresAt && now > sub.demoExpiresAt) {
      return { allowed: false, message: MSG.demoExpired, suspend: true }
    }
    // 30 respuestas de IA por conversación: NO se avisa al contacto. Se desactiva
    // la IA en ese chat y se guarda el motivo para mostrarlo SOLO a los
    // administradores (franja dentro del chat). El asesor humano puede continuar.
    const maxAi = sub.type.demoMaxAiResponsesPerConversation || AI_MSGS_PER_CONV
    if (maxAi > 0 && convId) {
      const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND sender='ai'", [convId])
      if (n >= maxAi) {
        await disableAiInConv(accId, convId, 'ai_per_conv_limit')
        return { allowed: false, disableAi: true, reason: 'ai_per_conv_limit', max: maxAi }
      }
    }
    // 100 contactos atendidos por la IA (mismo tope que el resto de familias).
    const contactId = await contactIdOf(convId)
    if (contactId) {
      const claim = await claimAiContact(accId, contactId, AI_CONTACT_LIMIT)
      if (!claim.allowed) {
        await disableAiInConv(accId, convId, 'ai_contact_limit')
        return { allowed: false, disableAi: true, reason: 'ai_contact_limit', max: AI_CONTACT_LIMIT }
      }
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
      const family = s.plan_family || null

      // ── Planes por familia (CRM/Agente/Gratuito) ──
      if (family) {
        if (family === 'free') {
          // Gratuito: sin cobro ni etapas. Solo se reinicia el contador de conversaciones
          // cada 30 días (su única limitación).
          if (s.current_period_end && now > s.current_period_end) {
            await pool.query(
              `UPDATE account_subscriptions SET conversation_count_current_period=0, contact_count_current_period=0, ai_contact_count_current_period=0,
                 last_alert_threshold=0, current_period_start=?, current_period_end=?, updated_at=? WHERE id=?`,
              [now, now + 30 * DAY, now, s.id]
            )
          }
          continue
        }
        // Gracia vencida (por tope de contactos o por falta de renovación) → baja a Gratuito "mes 2".
        if (s.status === 'grace' && s.grace_until && now > s.grace_until) {
          await downgradeToFree(s.account_id); continue
        }
        // Renovación vencida en WOMPI sin cobro aprobado (el cobro lo intenta el worker de
        // platformBilling; si declina, aquí abrimos 5 días de gracia). Stripe se rige por sus
        // webhooks (invoice.payment_failed → gracia); los planes a mano (sin pasarela) no se tocan.
        if (s.gateway === 'wompi' && s.next_charge_at && now > s.next_charge_at && s.status === 'active') {
          const until = now + 5 * DAY
          await pool.query("UPDATE account_subscriptions SET status='grace', grace_until=?, updated_at=? WHERE id=?", [until, now, s.id])
          socket.emit(s.account_id, 'subscription:alert', { accId: s.account_id, kind: 'renewal_grace', graceUntil: until })
          continue
        }
        // Reinicio del ciclo mensual de contactos (planes de pago por familia).
        if (s.current_period_end && now > s.current_period_end && s.status !== 'grace') {
          await pool.query(
            `UPDATE account_subscriptions SET contact_count_current_period=0, ai_contact_count_current_period=0, conversation_count_current_period=0, last_alert_threshold=0,
              current_period_start=?, current_period_end=?, updated_at=? WHERE id=?`,
            [now, now + 30 * DAY, now, s.id]
          )
        }
        continue
      }

      // ── Legacy (tipos Demo + planes por conversaciones) ──
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
  // Planes por familia + consumo por contactos.
  markContactActive, effectivePlanState, freeState, downgradeToFree,
  FAMILY_MODULES, ALL_MODULES, CRM_MODULES, CRM_BASIC_MODULES,
  MODULE_SETS, FREE_CONVERSATION_LIMIT,
  // Los dos topes de contactos: escribir (CRM) vs. responder con IA.
  sendGate, claimAiContact, AI_CONTACT_LIMIT, AI_MSGS_PER_CONV,
  // Fuente única de los límites de canales (la usan el gate y el payload de la cuenta).
  channelLimitsFor, CHANNEL_TYPES, FREE_CHANNEL_LIMITS,
}
