'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const rules = require('../services/crmRules')

const map = r => ({ id: r.id, name: r.name, triggerType: r.trigger_type, triggerDays: r.trigger_days, actionType: r.action_type, actionParams: parseJ(r.action_params, {}), enabled: !!r.enabled, lastRun: r.last_run, createdAt: r.created_at })

const list = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM crm_rules WHERE account_id=? ORDER BY created_at DESC', [req.params.accId]); res.json({ rules: rows.map(map), triggers: rules.TRIGGERS }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const b = req.body || {}
  const id = 'rule_' + uid()
  try {
    await pool.query('INSERT INTO crm_rules (id,account_id,name,trigger_type,trigger_days,action_type,action_params,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, accId, String(b.name || 'Regla').slice(0, 140), b.triggerType || 'deal_stale', Number(b.triggerDays) || 7, b.actionType || 'create_task', JSON.stringify(b.actionParams || {}), b.enabled === false ? 0 : 1, Date.now()])
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const update = async (req, res) => {
  const { accId, id } = req.params
  const b = req.body || {}
  try {
    const sets = [], vals = []
    if (b.name !== undefined) { sets.push('name=?'); vals.push(String(b.name).slice(0, 140)) }
    if (b.triggerType !== undefined) { sets.push('trigger_type=?'); vals.push(b.triggerType) }
    if (b.triggerDays !== undefined) { sets.push('trigger_days=?'); vals.push(Number(b.triggerDays) || 7) }
    if (b.actionParams !== undefined) { sets.push('action_params=?'); vals.push(JSON.stringify(b.actionParams || {})) }
    if (b.enabled !== undefined) { sets.push('enabled=?'); vals.push(b.enabled ? 1 : 0) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id, accId)
    await pool.query(`UPDATE crm_rules SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  try { await pool.query('DELETE FROM crm_rules WHERE id=? AND account_id=?', [id, accId]); await pool.query('DELETE FROM crm_rule_fires WHERE rule_id=?', [id]); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Ejecuta una regla ahora (además del worker periódico).
const run = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[r]] = await pool.query('SELECT * FROM crm_rules WHERE id=? AND account_id=?', [id, accId])
    if (!r) return res.status(404).json({ error: 'Regla no encontrada' })
    const created = await rules.evalRule(r)
    res.json({ ok: true, created })
  } catch (err) { console.error('[rule run]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, update, remove, run }
