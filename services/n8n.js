'use strict'
/**
 * N8N integration service — sends payloads to a configured Webhook Node.
 *
 * Uses Node 18+ global fetch + AbortController for timeouts. No extra deps.
 *
 * Responsibilities:
 *   - Resolve an integration by id (account-scoped or platform-global)
 *   - Build the auth headers based on `auth_type`
 *   - POST the payload with a strict timeout
 *   - Surface failures with a clean { ok, status, error } shape
 *
 * Designed to be safe to call from:
 *   - Flow engine node executors
 *   - AI tool onToolCall handlers
 *   - Trigger dispatchers
 *
 * Never throws to the caller for HTTP/network errors — returns
 * { ok: false, error } so callers can decide whether to follow
 * the 'error' branch in a flow / surface to the LLM.
 */

const pool = require('../db')
const { parseJ } = require('../utils')

// Resolve an integration row by id. Optionally restrict by account/scope.
// Returns null if not found or not visible to the caller's scope.
async function getIntegration(integrationId, { accountId } = {}) {
  if (!integrationId) return null
  const [[row]] = await pool.query('SELECT * FROM n8n_integrations WHERE id=?', [integrationId])
  if (!row) return null

  // Platform-global integrations are visible to every account.
  // Account-scoped integrations require the matching account_id.
  if (row.scope === 'account' && accountId && row.account_id !== accountId) return null
  return row
}

// Build the headers map for a given integration's auth strategy.
function buildAuthHeaders(integration) {
  const headers = { 'Content-Type': 'application/json' }
  switch (integration?.auth_type) {
    case 'header': {
      // auth_value expected as "Header-Name: value" or just "value" -> X-N8N-Token
      const v = String(integration.auth_value || '')
      if (v.includes(':')) {
        const [name, ...rest] = v.split(':')
        headers[name.trim()] = rest.join(':').trim()
      } else if (v) {
        headers['X-N8N-Token'] = v
      }
      break
    }
    case 'bearer':
      if (integration.auth_value) headers['Authorization'] = `Bearer ${integration.auth_value}`
      break
    case 'basic':
      if (integration.auth_value) {
        // auth_value can be either base64 already or "user:pass"
        const v = integration.auth_value
        const encoded = /^[A-Za-z0-9+/=]+$/.test(v) && v.length > 8 ? v : Buffer.from(v).toString('base64')
        headers['Authorization'] = `Basic ${encoded}`
      }
      break
    default:
      break
  }
  return headers
}

/**
 * Invoke an n8n webhook with a payload.
 *
 * @param {object} opts
 * @param {string} opts.integrationId     - row id of n8n_integrations
 * @param {string} [opts.accountId]       - scoping; required if integration is account-scoped
 * @param {object} opts.payload           - JSON body to send to n8n
 * @param {boolean} [opts.forceSync]      - override sync_mode to wait_response
 * @returns {Promise<{ok, status, data, error, integration}>}
 */
async function callN8N({ integrationId, accountId, payload = {}, forceSync = false }) {
  const integration = await getIntegration(integrationId, { accountId })
  if (!integration) return { ok: false, status: 0, error: 'Integration not found or not allowed' }
  if (!integration.webhook_url) return { ok: false, status: 0, error: 'Integration has no webhook_url' }

  const wantsResponse = forceSync || integration.sync_mode === 'wait_response'
  const timeoutMs     = Number(integration.timeout_ms) || 15000
  const headers       = buildAuthHeaders(integration)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(integration.webhook_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!wantsResponse) {
      // Fire & forget — still surface the status code for logging,
      // but don't bother decoding the body.
      return { ok: res.ok, status: res.status, integration }
    }

    // wait_response: parse JSON if possible, otherwise return raw text
    const text = await res.text()
    let data = text
    try { data = text ? JSON.parse(text) : null } catch { /* keep as text */ }
    return { ok: res.ok, status: res.status, data, integration }
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      error: aborted ? `Timeout after ${timeoutMs}ms` : (err.message || 'Network error'),
      integration,
    }
  } finally {
    clearTimeout(timer)
  }
}

// List integrations visible to a given account (own + platform-global).
async function listVisibleIntegrations(accountId) {
  const [rows] = await pool.query(
    `SELECT id, scope, name, webhook_url, auth_type, sync_mode, timeout_ms, created_at
     FROM n8n_integrations
     WHERE scope='platform' OR (scope='account' AND account_id=?)
     ORDER BY scope DESC, name ASC`,
    [accountId]
  )
  return rows
}

module.exports = { callN8N, getIntegration, listVisibleIntegrations, buildAuthHeaders }
