'use strict'
// Reglas/playbooks no-code del CRM: "si pasa X, haz Y".
// Un worker evalúa periódicamente las reglas activas y ejecuta la acción, con
// deduplicación (una regla no actúa dos veces sobre el mismo objetivo).
const pool = require('../db')
const { uid, parseJ } = require('../utils')

const DAY = 86400000

const TRIGGERS = {
  deal_stale:      'Deal estancado (sin moverse N días)',
  contact_inactive: 'Cliente inactivo (sin comprar N días)',
  deal_won:        'Deal ganado',
  deal_high_score: 'Deal caliente (alta intención)',
}

// Devuelve los objetivos que cumplen el disparador: [{ key, title, targetType, targetId }]
async function findTargets(rule) {
  const accId = rule.account_id
  const days = Number(rule.trigger_days) || 7
  const now = Date.now()
  const out = []
  if (rule.trigger_type === 'deal_stale' || rule.trigger_type === 'deal_won' || rule.trigger_type === 'deal_high_score') {
    const [pipes] = await pool.query('SELECT cards FROM pipelines WHERE account_id=?', [accId])
    // Para deal_high_score se necesita la intención de la conversación vinculada.
    let intentByConv = {}
    if (rule.trigger_type === 'deal_high_score') {
      const convIds = []
      for (const p of pipes) for (const c of parseJ(p.cards, [])) if (c.convId) convIds.push(c.convId)
      if (convIds.length) { const [cv] = await pool.query("SELECT id, buying_intent FROM conversations WHERE account_id=? AND id IN (?)", [accId, convIds]); for (const x of cv) intentByConv[x.id] = x.buying_intent }
    }
    for (const p of pipes) for (const c of parseJ(p.cards, [])) {
      if (rule.trigger_type === 'deal_stale') {
        if (c.status === 'won' || c.status === 'lost') continue
        const ref = c.movedAt || c.updatedAt || c.createdAt
        if (ref && (now - ref) >= days * DAY) out.push({ key: c.id, title: `Seguir deal estancado: ${c.title || 'Deal'}`, targetType: 'deal', targetId: c.id })
      } else if (rule.trigger_type === 'deal_won') {
        if (c.status === 'won') out.push({ key: c.id, title: `Postventa: ${c.title || 'Deal'}`, targetType: 'deal', targetId: c.id })
      } else if (rule.trigger_type === 'deal_high_score') {
        if (c.status === 'won' || c.status === 'lost') continue
        if (intentByConv[c.convId] === 'alta') out.push({ key: c.id, title: `Contactar ya (alta intención): ${c.title || 'Deal'}`, targetType: 'deal', targetId: c.id })
      }
    }
  } else if (rule.trigger_type === 'contact_inactive') {
    const [rows] = await pool.query(
      "SELECT o.contact_id, c.name, MAX(o.created_at) AS lastAt FROM orders o LEFT JOIN contacts c ON c.id=o.contact_id WHERE o.account_id=? AND o.contact_id IS NOT NULL AND o.status NOT IN('draft','canceled') GROUP BY o.contact_id",
      [accId])
    for (const r of rows) if ((now - Number(r.lastAt)) >= days * DAY) out.push({ key: r.contact_id, title: `Reconectar con ${r.name || 'cliente'} (inactivo ${Math.round((now - Number(r.lastAt)) / DAY)}d)`, targetType: 'contact', targetId: r.contact_id })
  }
  return out
}

async function evalRule(rule) {
  const targets = await findTargets(rule)
  const params = parseJ(rule.action_params, {})
  const now = Date.now()
  let created = 0
  for (const t of targets) {
    const [[fired]] = await pool.query('SELECT 1 AS x FROM crm_rule_fires WHERE rule_id=? AND target_id=? LIMIT 1', [rule.id, t.key])
    if (fired) continue
    // Acción: crear tarea (única acción por ahora).
    await pool.query(
      'INSERT INTO crm_tasks (id, account_id, target_type, target_id, title, description, due_at, assignee_id, assignee_name, status, priority, refs, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ['task_' + uid(), rule.account_id, t.targetType, t.targetId, t.title, `Generada por la regla "${rule.name}".`,
        params.dueDays ? now + Number(params.dueDays) * DAY : null, null, '', 'open', params.priority || 'normal', '[]', '⚙️ Automatización', now])
    await pool.query('INSERT IGNORE INTO crm_rule_fires (rule_id, target_id, fired_at) VALUES (?,?,?)', [rule.id, t.key, now])
    created++
  }
  await pool.query('UPDATE crm_rules SET last_run=? WHERE id=?', [now, rule.id])
  return created
}

async function runAll() {
  const [rules] = await pool.query('SELECT * FROM crm_rules WHERE enabled=1')
  for (const r of rules) { try { await evalRule(r) } catch (e) { console.warn('[crm rule]', r.id, e.message) } }
}

function startWorker() {
  setTimeout(() => runAll().catch(() => {}), 30000)          // 30s tras arrancar
  setInterval(() => runAll().catch(() => {}), 10 * 60000)    // cada 10 min
}

module.exports = { TRIGGERS, evalRule, runAll, startWorker }
