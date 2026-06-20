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
      `INSERT INTO subscription_plans (id,name,monthly_conversation_limit,is_custom_limit,grace_period_days,sort_order,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, b.name || 'Nuevo plan', n(b.monthlyConversationLimit, 0), b.isCustomLimit ? 1 : 0, n(b.gracePeriodDays, 5), n(b.sortOrder, 0), now, now]
    )
    res.json({ id })
  } catch (err) { console.error('[createPlan]', err); res.status(500).json({ error: 'Error interno' }) }
}
const updatePlan = async (req, res) => {
  if (!requireSA(req, res)) return
  const { id } = req.params; const b = req.body || {}
  const map = { name: 'name', monthlyConversationLimit: 'monthly_conversation_limit', isCustomLimit: 'is_custom_limit', gracePeriodDays: 'grace_period_days', sortOrder: 'sort_order' }
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

function n(v, d) { return v === undefined || v === null || v === '' ? d : Number(v) }

module.exports = {
  listTypes, createType, updateType, deleteType,
  listPlans, createPlan, updatePlan, deletePlan,
  getAccountSubscription, assign, action,
}
