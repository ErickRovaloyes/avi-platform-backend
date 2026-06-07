'use strict'
const crypto = require('crypto')
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const { hashApiKey } = require('../auth')

// Supported scopes — keep small and explicit so external integrations can be
// granted least-privilege. '*' means "all scopes" (use carefully).
const SUPPORTED_SCOPES = [
  '*',
  'messages:send',
  'messages:read',
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'conversations:write',
  'crm:tasks:write',
  'crm:notes:write',
]

// GET /api/accounts/:accId/api-keys
// Returns metadata only — never the raw key (it's only shown once at creation).
const list = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query(
      'SELECT id, name, prefix, scopes, last_used, created_at FROM api_keys WHERE account_id=? ORDER BY created_at DESC',
      [accId]
    )
    res.json(rows.map(r => ({
      id: r.id, name: r.name, prefix: r.prefix,
      scopes: parseJ(r.scopes, []),
      lastUsed: r.last_used, createdAt: r.created_at,
    })))
  } catch (err) { console.error('[apiKeys list]', err); res.status(500).json({ error: 'Error interno' }) }
}

// POST /api/accounts/:accId/api-keys
// Body: { name, scopes?: string[] }
// IMPORTANT: this is the ONLY moment the raw key is returned. Caller must store it.
const create = async (req, res) => {
  const { accId } = req.params
  const { name = '', scopes = ['*'] } = req.body || {}
  if (!name.trim()) return res.status(400).json({ error: 'name requerido' })

  // Validate scopes
  const filtered = scopes.filter(s => SUPPORTED_SCOPES.includes(s))
  if (!filtered.length) return res.status(400).json({ error: 'Se requiere al menos un scope válido' })

  // Generate a random 32-byte key, prefix it with avi_live_ for clarity.
  const rand   = crypto.randomBytes(24).toString('base64url')
  const rawKey = `avi_live_${rand}`
  const prefix = rawKey.slice(0, 16)       // shown in lists, e.g. avi_live_aB12…
  const hash   = hashApiKey(rawKey)
  const id     = 'apk_' + uid()

  try {
    await pool.query(
      'INSERT INTO api_keys (id, account_id, name, key_hash, prefix, scopes, created_at) VALUES (?,?,?,?,?,?,?)',
      [id, accId, name.trim(), hash, prefix, JSON.stringify(filtered), Date.now()]
    )
    res.json({ id, name, prefix, scopes: filtered, key: rawKey, ts: Date.now() })
  } catch (err) { console.error('[apiKeys create]', err); res.status(500).json({ error: 'Error interno' }) }
}

// DELETE /api/accounts/:accId/api-keys/:id
const remove = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query('DELETE FROM api_keys WHERE id=? AND account_id=?', [id, accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, remove, SUPPORTED_SCOPES }
