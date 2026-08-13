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

const COOKIE = 'avi_jwt'

/**
 * El token de la petición: PRIMERO la cookie, luego la cabecera de siempre.
 *
 * La cookie es `httpOnly`, así que ningún script de la página puede leerla — que es el
 * objetivo: con el token en localStorage, cualquier XSS (propio o de una dependencia) se lo
 * llevaba y podía suplantar al usuario sin caducidad ni forma de revocarlo.
 *
 * Se sigue aceptando `Authorization: Bearer` a propósito, y no debilita nada: si el token ya
 * no se guarda en el navegador, no hay nada que robar. Lo que sí evita es romper la app móvil
 * y cualquier integración por API, que mandan la cabecera y no tienen cookies.
 */
function tokenDe(req) {
  const cookies = req.headers.cookie || ''
  for (const trozo of cookies.split(';')) {
    const [k, ...resto] = trozo.trim().split('=')
    if (k === COOKIE && resto.length) return decodeURIComponent(resto.join('='))
  }
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

/**
 * Deja la sesión en una cookie httpOnly.
 *
 * `Secure` se decide por la conexión REAL del usuario: Traefik termina TLS y nos habla en
 * claro, así que mirar el protocolo de esta conexión daría siempre http y el navegador
 * descartaría la cookie. Por eso se mira X-Forwarded-Proto, que es quien sabe la verdad.
 *
 * `SameSite=Lax` y no `Strict`: con Strict el navegador NO manda la cookie al llegar desde un
 * enlace externo (un correo, un WhatsApp), así que el usuario aterriza deslogueado y tiene
 * que navegar una vez para «recuperar» la sesión. Lax sigue bloqueando el POST entre sitios,
 * que es el vector de CSRF que importa.
 */
function ponerCookie(req, res, token) {
  const seguro = (req.headers['x-forwarded-proto'] || req.protocol) === 'https'
  // La misma vida que el token (365d, ver sign). Ponerle menos —la auditoría sugería un
  // día— desconectaría a todo el mundo a diario sin cerrar sesión, que es un cambio de
  // comportamiento del producto y no lo que el hallazgo pedía: lo que resolvía era que un
  // XSS pudiera robar el token, y eso lo arregla `HttpOnly`, dure lo que dure.
  const partes = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Max-Age=${365 * 24 * 60 * 60}`,
  ]
  if (seguro) partes.push('Secure')
  res.append('Set-Cookie', partes.join('; '))
}

/** Cierra la sesión del navegador. Max-Age=0 pide al navegador que la borre ya. */
function quitarCookie(req, res) {
  const seguro = (req.headers['x-forwarded-proto'] || req.protocol) === 'https'
  const partes = [`${COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0']
  if (seguro) partes.push('Secure')
  res.append('Set-Cookie', partes.join('; '))
}

/** Emite la sesión: cookie para el navegador + token en el JSON para los clientes de API. */
function emitirSesion(req, res, session) {
  const token = sign(session)
  ponerCookie(req, res, token)
  return { token, session }
}

function authMiddleware(req, res, next) {
  const token = tokenDe(req)
  if (!token) return res.status(401).json({ error: 'Token requerido' })
  const payload = verify(token)
  if (!payload) return res.status(401).json({ error: 'Token inválido o expirado' })
  req.user = payload
  next()
}

/**
 * Solo super administradores.
 *
 * `authMiddleware` comprueba que HAY sesión, no QUIÉN es: cualquier usuario de cualquier
 * cuenta cliente la pasa. Las rutas de administración necesitan además esto, y varias lo
 * daban por hecho — estaban comentadas como «Superadmin: …» pero sin ninguna comprobación,
 * así que quedaban abiertas a todo el que hubiera iniciado sesión.
 *
 * Se usa DESPUÉS de authMiddleware, que es quien rellena req.user.
 */
function soloSuperadmin(req, res, next) {
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  next()
}

// Optional auth — attaches user if token present but does not block
function optionalAuth(req, res, next) {
  const token = tokenDe(req)
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

module.exports = { sign, verify, authMiddleware, soloSuperadmin, optionalAuth, apiKeyAuth, hashApiKey,
  tokenDe, ponerCookie, quitarCookie, emitirSesion, COOKIE }
