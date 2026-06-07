'use strict'
const pool = require('../db')
const { uid } = require('../utils')
const { callN8N } = require('../services/n8n')

const SCOPES = ['platform', 'account']

// Mask the auth value when returning to non-owners — show prefix only.
function safe(row, { isOwner }) {
  return {
    id: row.id,
    scope: row.scope,
    accountId: row.account_id,
    name: row.name,
    webhookUrl: row.webhook_url,
    authType: row.auth_type || 'none',
    // Hide raw secret unless caller is owner (super admin for scope=platform,
    // or any account member for scope=account where account_id matches).
    authValue: isOwner ? (row.auth_value || '') : (row.auth_value ? `${(row.auth_value || '').slice(0, 4)}…` : ''),
    syncMode: row.sync_mode || 'fire_forget',
    timeoutMs: row.timeout_ms || 15000,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

// GET /api/n8n/integrations?scope=account|platform&accountId=...
// Lists integrations visible to the caller:
//   - super admin: all platform integrations (+ optional accountId filter)
//   - account member: own account's integrations + platform-global templates (read-only)
const list = async (req, res) => {
  const { scope, accountId } = req.query
  try {
    if (req.user?.type === 'superadmin') {
      const where = []; const params = []
      if (scope)     { where.push('scope=?');      params.push(scope) }
      if (accountId) { where.push('account_id=?'); params.push(accountId) }
      const sql = `SELECT * FROM n8n_integrations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY scope DESC, name ASC`
      const [rows] = await pool.query(sql, params)
      return res.json(rows.map(r => safe(r, { isOwner: true })))
    }

    // Member: union of own account + platform-global templates
    const callerAcc = req.user?.accountId
    const [rows] = await pool.query(
      `SELECT * FROM n8n_integrations
       WHERE scope='platform' OR (scope='account' AND account_id=?)
       ORDER BY scope DESC, name ASC`,
      [callerAcc]
    )
    res.json(rows.map(r => safe(r, { isOwner: r.scope === 'account' && r.account_id === callerAcc })))
  } catch (err) { console.error('[N8N list]', err); res.status(500).json({ error: 'Error interno' }) }
}

// POST /api/n8n/integrations
// Body: { scope, accountId?, name, webhookUrl, authType, authValue, syncMode, timeoutMs }
const create = async (req, res) => {
  const { scope = 'account', accountId, name, webhookUrl, authType = 'none', authValue = '', syncMode = 'fire_forget', timeoutMs = 15000 } = req.body || {}
  if (!SCOPES.includes(scope))   return res.status(400).json({ error: 'scope debe ser platform o account' })
  if (!name || !webhookUrl)      return res.status(400).json({ error: 'name y webhookUrl son requeridos' })

  // Authorization: only super admin can create platform-global integrations.
  // Account members can only create for their own account.
  if (scope === 'platform' && req.user?.type !== 'superadmin') {
    return res.status(403).json({ error: 'Solo super admin puede crear plantillas globales' })
  }
  const finalAccountId = scope === 'platform' ? null
                       : (req.user?.type === 'superadmin' ? accountId : req.user?.accountId)
  if (scope === 'account' && !finalAccountId) return res.status(400).json({ error: 'accountId requerido para scope=account' })

  const id = 'n8n_' + uid()
  try {
    await pool.query(
      `INSERT INTO n8n_integrations (id, scope, account_id, name, webhook_url, auth_type, auth_value, sync_mode, timeout_ms, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, scope, finalAccountId, name, webhookUrl, authType, authValue, syncMode, parseInt(timeoutMs) || 15000, req.user?.name || '', Date.now()]
    )
    res.json({ id })
  } catch (err) { console.error('[N8N create]', err); res.status(500).json({ error: 'Error interno' }) }
}

// PUT /api/n8n/integrations/:id
const update = async (req, res) => {
  const { id } = req.params
  const { name, webhookUrl, authType, authValue, syncMode, timeoutMs } = req.body || {}
  try {
    const [[row]] = await pool.query('SELECT * FROM n8n_integrations WHERE id=?', [id])
    if (!row) return res.status(404).json({ error: 'No encontrado' })
    // Owner check
    if (row.scope === 'platform' && req.user?.type !== 'superadmin') {
      return res.status(403).json({ error: 'Solo super admin puede modificar plantillas globales' })
    }
    if (row.scope === 'account' && req.user?.type !== 'superadmin' && row.account_id !== req.user?.accountId) {
      return res.status(403).json({ error: 'Sin permiso' })
    }
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');         vals.push(name) }
    if (webhookUrl  !== undefined) { sets.push('webhook_url=?');  vals.push(webhookUrl) }
    if (authType    !== undefined) { sets.push('auth_type=?');    vals.push(authType) }
    if (authValue   !== undefined) { sets.push('auth_value=?');   vals.push(authValue) }
    if (syncMode    !== undefined) { sets.push('sync_mode=?');    vals.push(syncMode) }
    if (timeoutMs   !== undefined) { sets.push('timeout_ms=?');   vals.push(parseInt(timeoutMs) || 15000) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id)
    await pool.query(`UPDATE n8n_integrations SET ${sets.join(',')} WHERE id=?`, vals)
    res.json({ ok: true })
  } catch (err) { console.error('[N8N update]', err); res.status(500).json({ error: 'Error interno' }) }
}

// DELETE /api/n8n/integrations/:id
const remove = async (req, res) => {
  const { id } = req.params
  try {
    const [[row]] = await pool.query('SELECT * FROM n8n_integrations WHERE id=?', [id])
    if (!row) return res.json({ ok: true })
    if (row.scope === 'platform' && req.user?.type !== 'superadmin') {
      return res.status(403).json({ error: 'Solo super admin puede eliminar plantillas globales' })
    }
    if (row.scope === 'account' && req.user?.type !== 'superadmin' && row.account_id !== req.user?.accountId) {
      return res.status(403).json({ error: 'Sin permiso' })
    }
    await pool.query('DELETE FROM n8n_integrations WHERE id=?', [id])
    res.json({ ok: true })
  } catch (err) { console.error('[N8N delete]', err); res.status(500).json({ error: 'Error interno' }) }
}

// POST /api/n8n/integrations/:id/test
// Sends a small payload to verify connectivity.
const test = async (req, res) => {
  const { id } = req.params
  const accountId = req.user?.type === 'superadmin' ? null : req.user?.accountId
  const r = await callN8N({
    integrationId: id,
    accountId,
    payload: {
      event: 'avi.integration.test',
      ts: Date.now(),
      message: 'Test payload desde AVI Platform',
    },
    forceSync: true,
  })
  res.json(r)
}

// POST /api/n8n/integrations/:id/dispatch
// Body: { payload, accountId?, forceSync? }
// Used by the FRONTEND (flow engine, ai tool handlers) to fire a webhook without
// ever exposing the integration's secrets to the browser. Returns the n8n
// response when sync_mode='wait_response' (or forceSync).
const dispatch = async (req, res) => {
  const { id } = req.params
  const { payload = {}, forceSync = false } = req.body || {}
  // Scope check: only super admin can target any account; members only their own.
  const callerAcc = req.user?.type === 'superadmin' ? null : req.user?.accountId
  try {
    const r = await callN8N({ integrationId: id, accountId: callerAcc, payload, forceSync })
    res.json(r)
  } catch (err) { res.status(500).json({ error: err.message || 'Error interno' }) }
}

module.exports = { list, create, update, remove, test, dispatch }
