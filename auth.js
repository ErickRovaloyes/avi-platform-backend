const jwt = require('jsonwebtoken')
const crypto = require('crypto')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const SECRET = process.env.JWT_SECRET || 'avi_secret_dev_key_change_in_production'

// Stable hash for API keys (sha256 hex). The plaintext is shown to the user once at creation;
// only the hash is stored. Subsequent verifications hash the incoming key and compare.
function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key || ''), 'utf8').digest('hex')
}

function sign(payload) {
  // Strip JWT-reserved claims that may be present when re-signing a previously
  // decoded token (e.g. switchAccount/impersonate/refresh spread req.user).
  // Passing `exp`/`iat` in the payload conflicts with `expiresIn`.
  const { exp, iat, nbf, ...rest } = payload || {}
  // Sesión persistente: el usuario permanece logueado hasta que cierra sesión. El token
  // se guarda en localStorage (persiste al cerrar el navegador) y expira solo tras 1 año.
  return jwt.sign(rest, SECRET, { expiresIn: '365d' })
}

function verify(token) {
  try { return jwt.verify(token, SECRET) } catch { return null }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || ''
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Token requerido' })
  const payload = verify(token)
  if (!payload) return res.status(401).json({ error: 'Token inválido o expirado' })
  req.user = payload
  next()
}

// Optional auth — attaches user if token present but does not block
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null
  if (token) req.user = verify(token) || null
  next()
}

// API key authentication for the public /api/v1/* surface.
// Header: X-AVI-Key: avi_live_<random>
// Populates req.user = { type:'api_key', accountId, apiKeyId, scopes:[...] }
// Optional usage: require a specific scope by passing `requiredScope`.
function apiKeyAuth(requiredScope = null) {
  return async function (req, res, next) {
    try {
      const raw = req.headers['x-avi-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      if (!raw) return res.status(401).json({ error: 'API key requerida (header X-AVI-Key)' })

      const pool = require('./db')
      const { parseJ } = require('./utils')
      const hash = hashApiKey(raw)
      const [[row]] = await pool.query('SELECT * FROM api_keys WHERE key_hash=? LIMIT 1', [hash])
      if (!row) return res.status(401).json({ error: 'API key inválida' })

      const scopes = parseJ(row.scopes, [])
      if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('*')) {
        return res.status(403).json({ error: `API key sin permiso: ${requiredScope}` })
      }

      // Best-effort last_used update (don't block the request)
      pool.query('UPDATE api_keys SET last_used=? WHERE id=?', [Date.now(), row.id]).catch(() => {})

      req.user = { type: 'api_key', apiKeyId: row.id, accountId: row.account_id, scopes }
      next()
    } catch (err) {
      console.error('[apiKeyAuth]', err)
      res.status(500).json({ error: 'Error de autenticación' })
    }
  }
}

module.exports = { sign, verify, authMiddleware, optionalAuth, apiKeyAuth, hashApiKey }
