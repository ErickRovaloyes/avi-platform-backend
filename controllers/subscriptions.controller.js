'use strict'
const pool = require('../db')
const { uid } = require('../utils')
const subs = require('../services/subscriptions')

const requireSA = (req, res) => {
  if (req.user?.type !== 'superadmin') { res.status(403).json({ error: 'Solo superadmin' }); return false }
  return true
}

// ── Account types ─────────────────────────────────────────────────────────────
const listTypes = async (req, res) => {
  try { res.json(await subs.listTypes()) } catch { res.status(500).json({ error: 'Error interno' }) }
}
const createType = async (req, res) => {
  if (!requireSA(req, res)) return
  const b = req.body || {}
  const now = Date.now()
  const id = 'atype_' + uid()
  try {
    await pool.query(
      `INSERT INTO account_types
        (id,name,max_webchat_channels,max_whatsapp_channels,max_test_channels,max_messenger_channels,max_instagram_channels,
         is_demo,demo_days_duration,demo_max_conversations,demo_max_ai_responses_per_conversation,sort_order,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name || 'Nuevo tipo', n(b.maxWebchatChannels, 1), n(b.maxWhatsappChannels, 1), n(b.maxTestChannels, 1),
       n(b.maxMessengerChannels, 0), n(b.maxInstagramChannels, 0), b.isDemo ? 1 : 0,
       n(b.demoDaysDuration, 7), n(b.demoMaxConversations, 100), n(b.demoMaxAiResponsesPerConversation, 30),
       n(b.sortOrder, 0), now, now]
    )
    res.json({ id })
  } catch (err) { console.error('[createType]', err); res.status(500).json({ error: 'Error interno' }) }
}
const updateType = async (req, res) => {
  if (!requireSA(req, res)) return
  const { id } = req.params; const b = req.body || {}
  const map = {
    name: 'name', maxWebchatChannels: 'max_webchat_channels', maxWhatsappChannels: 'max_whatsapp_channels',
    maxTestChannels: 'max_test_channels', maxMessengerChannels: 'max_messenger_channels',
    maxInstagramChannels: 'max_instagram_channels', isDemo: 'is_demo', demoDaysDuration: 'demo_days_duration',
    demoMaxConversations: 'demo_max_conversations', demoMaxAiResponsesPerConversation: 'demo_max_ai_responses_per_conversation',
    sortOrder: 'sort_order',
  }
  const sets = [], vals = []
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(k === 'isDemo' ? (b[k] ? 1 : 0) : b[k]) }
  }
  if (!sets.length) return res.json({ ok: true })
  sets.push('updated_at=?'); vals.push(Date.now(), id)
  try { await pool.query(`UPDATE account_types SET ${sets.join(',')} WHERE id=?`, vals); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}
const deleteType = async (req, res) => {
  if (!requireSA(req, res)) return
  try { await pool.query('DELETE FROM account_types WHERE id=?', [req.params.id]); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// ── Subscription plans ────────────────────────────────────────────────────────
const listPlans = async (req, res) => {
  try { res.json(await subs.listPlans()) } catch { res.status(500).json({ error: 'Error interno' }) }
}
const createPlan = async (req, res) => {
  if (!requireSA(req, res)) return
  const b = req.body || {}; const now = Date.now(); const id = 'plan_' + uid()
  try {
    await pool.query(
      `INSERT INTO subscription_plans (id,name,monthly_conversation_limit,is_custom_limit,grace_period_days,monthly_price,sort_order,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, b.name || 'Nuevo plan', n(b.monthlyConversationLimit, 0), b.isCustomLimit ? 1 : 0, n(b.gracePeriodDays, 5), n(b.monthlyPrice, 0), n(b.sortOrder, 0), now, now]
    )
    res.json({ id })
  } catch (err) { console.error('[createPlan]', err); res.status(500).json({ error: 'Error interno' }) }
}
const updatePlan = async (req, res) => {
  if (!requireSA(req, res)) return
  const { id } = req.params; const b = req.body || {}
  const map = { name: 'name', monthlyConversationLimit: 'monthly_conversation_limit', isCustomLimit: 'is_custom_limit', gracePeriodDays: 'grace_period_days', monthlyPrice: 'monthly_price', sortOrder: 'sort_order' }
  const sets = [], vals = []
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(k === 'isCustomLimit' ? (b[k] ? 1 : 0) : b[k]) }
  }
  if (!sets.length) return res.json({ ok: true })
  sets.push('updated_at=?'); vals.push(Date.now(), id)
  try { await pool.query(`UPDATE subscription_plans SET ${sets.join(',')} WHERE id=?`, vals); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}
const deletePlan = async (req, res) => {
  if (!requireSA(req, res)) return
  try { await pool.query('DELETE FROM subscription_plans WHERE id=?', [req.params.id]); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// Gate PÚBLICO (sin auth): lo usa el motor de flujos del navegador (webchat/test)
// para aplicar los mismos límites de suscripción que el motor del servidor.
const publicGate = async (req, res) => {
  try {
    const { accId, convId } = req.params
    const g = await subs.assistantGate(accId, convId)
    if (g && g.closeConv) { try { await subs.closeConversation(accId, convId) } catch {} }
    res.json(g || { allowed: true })
  } catch { res.json({ allowed: true }) }
}

// ── Account subscription (asignación + estado) ────────────────────────────────
// Lectura: superadmin de cualquiera; owner solo de su propia cuenta.
const getAccountSubscription = async (req, res) => {
  const { accId } = req.params
  if (req.user?.type !== 'superadmin' && req.user?.accountId !== accId) return res.status(403).json({ error: 'No autorizado' })
  try {
    const sub = await subs.getSubscription(accId)
    const limit = sub ? subs.effectiveMonthlyLimit(sub) : null
    // Uso de canales (cuenta entre todos los agentes) para la pestaña Cuenta.
    const channelUsage = { webchat: 0, whatsapp: 0, test: 0, messenger: 0, instagram: 0 }
    try {
      const [agents] = await pool.query('SELECT channels FROM agents WHERE account_id=?', [accId])
      for (const a of agents) {
        let chs = []; try { chs = JSON.parse(a.channels || '[]') } catch {}
        for (const c of chs) if (channelUsage[c.type] != null) channelUsage[c.type]++
      }
    } catch {}
    res.json({ subscription: sub, effectiveMonthlyLimit: limit, channelUsage })
  } catch (err) { console.error('[getAccountSubscription]', err); res.status(500).json({ error: 'Error interno' }) }
}
const assign = async (req, res) => {
  if (!requireSA(req, res)) return
  const { accId } = req.params
  const { accountTypeId, subscriptionPlanId, customMonthlyLimit } = req.body || {}
  try { res.json(await subs.assignSubscription(accId, { accountTypeId, subscriptionPlanId, customMonthlyLimit })) }
  catch (err) { console.error('[assign]', err); res.status(500).json({ error: 'Error interno' }) }
}
// Acciones rápidas del superadmin sobre la suscripción de una cuenta.
const action = async (req, res) => {
  if (!requireSA(req, res)) return
  const { accId } = req.params
  const { type, value } = req.body || {}
  const now = Date.now()
  try {
    if (type === 'suspend')      await pool.query("UPDATE account_subscriptions SET status='suspended', updated_at=? WHERE account_id=?", [now, accId])
    else if (type === 'reactivate') await pool.query("UPDATE account_subscriptions SET status='active', grace_until=NULL, updated_at=? WHERE account_id=?", [now, accId])
    else if (type === 'extendGrace') await pool.query("UPDATE account_subscriptions SET status='grace', grace_until=?, updated_at=? WHERE account_id=?", [now + (Number(value) || 5) * 86400000, now, accId])
    else if (type === 'resetConsumption') await pool.query("UPDATE account_subscriptions SET conversation_count_current_period=0, last_alert_threshold=0, updated_at=? WHERE account_id=?", [now, accId])
    else if (type === 'setCustomLimit') await pool.query('UPDATE account_subscriptions SET custom_monthly_limit=?, updated_at=? WHERE account_id=?', [Number(value) || null, now, accId])
    else return res.status(400).json({ error: 'Acción no válida' })
    const socket = require('../services/socket'); socket.emit(accId, 'account:updated', { accId })
    res.json(await subs.getSubscription(accId))
  } catch (err) { console.error('[sub action]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Dashboard de supervisión (superadmin) ─────────────────────────────────────
const getOverview = async (req, res) => {
  if (!requireSA(req, res)) return
  const now = Date.now()
  const DAY = 86400000
  try {
    const [accounts] = await pool.query('SELECT id,name,email,status,created_at FROM accounts')
    const [subsRows] = await pool.query('SELECT * FROM account_subscriptions')
    const types = await subs.listTypes()
    const plans = await subs.listPlans()
    const typeById = Object.fromEntries(types.map(t => [t.id, t]))
    const planById = Object.fromEntries(plans.map(p => [p.id, p]))
    const subByAcc = Object.fromEntries(subsRows.map(s => [s.account_id, s]))
    // Uso de canales por cuenta (entre todos los agentes) para el reporte de canales.
    const chUsage = {}
    try {
      const [agents] = await pool.query('SELECT account_id, channels FROM agents')
      for (const a of agents) {
        const m = chUsage[a.account_id] || (chUsage[a.account_id] = { webchat: 0, whatsapp: 0, test: 0, messenger: 0, instagram: 0 })
        let chs = []; try { chs = JSON.parse(a.channels || '[]') } catch {}
        for (const c of chs) if (m[c.type] != null) m[c.type]++
      }
    } catch {}

    const list = accounts.map(a => {
      const s = subByAcc[a.id]
      const type = s ? typeById[s.account_type_id] : null
      const plan = s ? planById[s.subscription_plan_id] : null
      const isDemo = !!type?.isDemo
      const used = s?.conversation_count_current_period || 0
      let limit = null
      if (plan) limit = plan.isCustomLimit ? (s?.custom_monthly_limit ?? null) : (plan.monthlyConversationLimit || 0)
      const pct = (limit && limit > 0) ? Math.round((used / limit) * 100) : null
      return {
        accId: a.id, name: a.name, email: a.email, createdAt: a.created_at, accountStatus: a.status,
        hasSub: !!s, typeId: s?.account_type_id || null, typeName: type?.name || (s ? '—' : 'Sin asignar'), isDemo,
        planId: s?.subscription_plan_id || null, planName: plan?.name || (isDemo ? 'Demo' : (s ? '—' : '')),
        status: s?.status || (s ? 'active' : 'none'), used, limit, pct,
        channelUsage: chUsage[a.id] || { webchat: 0, whatsapp: 0, test: 0, messenger: 0, instagram: 0 },
        currentPeriodEnd: s?.current_period_end || null,
        cycleDaysLeft: s?.current_period_end ? Math.max(0, Math.ceil((s.current_period_end - now) / DAY)) : null,
        graceUntil: s?.grace_until || null,
        graceDaysLeft: s?.grace_until ? Math.max(0, Math.ceil((s.grace_until - now) / DAY)) : null,
        demoExpiresAt: s?.demo_expires_at || null,
        demoDaysLeft: s?.demo_expires_at ? Math.max(0, Math.ceil((s.demo_expires_at - now) / DAY)) : null,
        customMonthlyLimit: s?.custom_monthly_limit ?? null,
      }
    })
    const isSuspended = x => x.status === 'suspended' || x.status === 'expired' || x.accountStatus === 'suspended'
    const kpis = {
      total: list.length,
      active: list.filter(x => !isSuspended(x)).length,
      suspended: list.filter(isSuspended).length,
      demo: list.filter(x => x.isDemo).length,
      paid: list.filter(x => x.hasSub && !x.isDemo).length,
      noSub: list.filter(x => !x.hasSub).length,
    }
    const byType = {}, byPlan = {}
    for (const x of list) if (x.hasSub) {
      byType[x.typeName] = (byType[x.typeName] || 0) + 1
      if (!x.isDemo && x.planName && x.planName !== '—') byPlan[x.planName] = (byPlan[x.planName] || 0) + 1
    }
    const statusBuckets = {
      alDia: list.filter(x => x.status === 'active').length,
      porVencer: list.filter(x => x.status === 'active' && !x.isDemo && x.cycleDaysLeft != null && x.cycleDaysLeft <= 7).length,
      enGracia: list.filter(x => x.status === 'grace').length,
      suspendidas: list.filter(x => x.status === 'suspended' || x.status === 'expired').length,
      demoPorExpirar: list.filter(x => x.isDemo && x.status !== 'expired' && x.demoDaysLeft != null && x.demoDaysLeft <= 3).length,
    }
    const consumption = {
      normal: list.filter(x => x.pct != null && x.pct < 80).length,
      amarilla: list.filter(x => x.pct != null && x.pct >= 80 && x.pct < 90).length,
      naranja: list.filter(x => x.pct != null && x.pct >= 90 && x.pct < 100).length,
      roja: list.filter(x => x.pct != null && x.pct >= 100).length,
    }
    res.json({ kpis, byType, byPlan, statusBuckets, consumption, accounts: list, types, plans, generatedAt: now })
  } catch (err) { console.error('[overview]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Dashboard comercial (MRR, conversiones Demo→Pago, etc.) ────────────────────
const getCommercial = async (req, res) => {
  if (!requireSA(req, res)) return
  const now = Date.now()
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
  const ms = monthStart.getTime()
  try {
    const [accounts] = await pool.query('SELECT id,status,created_at FROM accounts')
    const [subsRows] = await pool.query('SELECT * FROM account_subscriptions')
    const plans = await subs.listPlans()
    const types = await subs.listTypes()
    const planById = Object.fromEntries(plans.map(p => [p.id, p]))
    const typeById = Object.fromEntries(types.map(t => [t.id, t]))

    let mrr = 0
    const revenueByPlan = {}
    let totalConversationsCycle = 0
    let activeDemos = 0
    for (const s of subsRows) {
      const type = typeById[s.account_type_id]
      const plan = planById[s.subscription_plan_id]
      totalConversationsCycle += s.conversation_count_current_period || 0
      const blocked = s.status === 'suspended' || s.status === 'expired'
      if (type?.isDemo) { if (!blocked) activeDemos++; continue }
      if (plan && !blocked) {
        const price = plan.isCustomLimit ? (plan.monthlyPrice || 0) : (plan.monthlyPrice || 0)
        mrr += price
        revenueByPlan[plan.name] = (revenueByPlan[plan.name] || 0) + price
      }
    }
    // Conversiones Demo → Pago (registros marcados 'converted')
    const [[{ conv }]] = await pool.query("SELECT COUNT(*) AS conv FROM demo_registrations WHERE status='converted'")
    const [[{ demosCreated }]] = await pool.query("SELECT COUNT(*) AS demosCreated FROM demo_registrations WHERE result IN ('created','created_override')")
    const [[{ convMonth }]] = await pool.query("SELECT COUNT(*) AS convMonth FROM demo_registrations WHERE status='converted' AND created_at>=?", [ms])
    const conversionRate = demosCreated ? Math.round((conv / demosCreated) * 100) : 0

    const newThisMonth = accounts.filter(a => (a.created_at || 0) >= ms).length
    const suspended = subsRows.filter(s => s.status === 'suspended' || s.status === 'expired').length

    res.json({
      mrr, revenueByPlan, currency: 'USD',
      activeDemos, conversions: conv, conversionsThisMonth: convMonth, demosCreated, conversionRate,
      newAccountsThisMonth: newThisMonth, suspendedAccounts: suspended,
      totalConversationsCycle, totalAccounts: accounts.length, generatedAt: now,
    })
  } catch (err) { console.error('[commercial]', err); res.status(500).json({ error: 'Error interno' }) }
}

function n(v, d) { return v === undefined || v === null || v === '' ? d : Number(v) }

module.exports = {
  listTypes, createType, updateType, deleteType,
  listPlans, createPlan, updatePlan, deletePlan,
  getAccountSubscription, assign, action, getOverview, getCommercial, publicGate,
}
