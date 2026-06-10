'use strict'
/**
 * Google OAuth + Sheets API.
 *
 * El dueño de la plataforma registra UNA app OAuth en Google Cloud (Sheets API
 * habilitada) y configura estas variables de entorno en el backend:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 * (GOOGLE_REDIRECT_URI = https://platform.aviasistente.com/api/google/callback)
 *
 * Cada cuenta hace "Conectar con Google" y autoriza a esa app a acceder a SUS
 * hojas. Guardamos el refresh_token por cuenta y refrescamos el access_token
 * cuando hace falta.
 */

const pool = require('../db')

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'https://platform.aviasistente.com/api/google/callback'
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
]

function isConfigured() { return !!(CLIENT_ID && CLIENT_SECRET) }

// URL de consentimiento. state = accId para saber a qué cuenta vincular.
function getAuthUrl(accId) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',           // fuerza refresh_token
    include_granted_scopes: 'true',
    scope: SCOPES.join(' '),
    state: accId,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error('Intercambio de código falló: ' + (await res.text()).slice(0, 200))
  return res.json() // { access_token, refresh_token, expires_in, scope, id_token }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error('Refresh token falló: ' + (await res.text()).slice(0, 200))
  return res.json() // { access_token, expires_in }
}

async function getUserEmail(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const d = await res.json()
    return d?.email || ''
  } catch { return '' }
}

// Guarda/actualiza la integración de una cuenta.
async function saveIntegration(accId, { access_token, refresh_token, expires_in, scope }, email) {
  const expiry = Date.now() + (Number(expires_in) || 3600) * 1000
  await pool.query(
    `INSERT INTO google_integrations (account_id, email, access_token, refresh_token, expiry, scope, connected_at)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE email=VALUES(email), access_token=VALUES(access_token),
       refresh_token=COALESCE(VALUES(refresh_token), refresh_token), expiry=VALUES(expiry), scope=VALUES(scope)`,
    [accId, email || '', access_token, refresh_token || null, expiry, scope || '', Date.now()]
  )
}

// Devuelve un access_token válido para la cuenta, refrescando si expiró.
async function getValidAccessToken(accId) {
  const [[row]] = await pool.query('SELECT * FROM google_integrations WHERE account_id=?', [accId])
  if (!row) throw new Error('La cuenta no tiene Google conectado')
  if (row.access_token && Number(row.expiry) > Date.now() + 60000) return row.access_token
  if (!row.refresh_token) throw new Error('Falta refresh_token; reconecta Google')
  const r = await refreshAccessToken(row.refresh_token)
  const expiry = Date.now() + (Number(r.expires_in) || 3600) * 1000
  await pool.query('UPDATE google_integrations SET access_token=?, expiry=? WHERE account_id=?', [r.access_token, expiry, accId])
  return r.access_token
}

// ── Sheets API ───────────────────────────────────────────────────────────────
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'

async function sheetsApi(token, path, { method = 'GET', body, qs } = {}) {
  const url = `${SHEETS}/${path}${qs ? '?' + new URLSearchParams(qs).toString() : ''}`
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `Sheets HTTP ${res.status}`)
  return data
}

// Lee un rango (ej. "Hoja1!A1:Z100") → array de filas
async function readRows(token, spreadsheetId, range) {
  const d = await sheetsApi(token, `${spreadsheetId}/values/${encodeURIComponent(range)}`)
  return d.values || []
}
// Añade una fila al final de un rango/hoja
async function appendRow(token, spreadsheetId, range, values) {
  return sheetsApi(token, `${spreadsheetId}/values/${encodeURIComponent(range)}:append`, {
    method: 'POST', qs: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
    body: { values: [values] },
  })
}
// Reemplaza el contenido de un rango concreto (ej. "Hoja1!A5:D5")
async function updateRange(token, spreadsheetId, range, values) {
  return sheetsApi(token, `${spreadsheetId}/values/${encodeURIComponent(range)}`, {
    method: 'PUT', qs: { valueInputOption: 'USER_ENTERED' },
    body: { values: [values] },
  })
}
// Vacía un rango (borra el contenido de las celdas)
async function clearRange(token, spreadsheetId, range) {
  return sheetsApi(token, `${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, { method: 'POST', body: {} })
}

// Extrae el spreadsheetId de un link de Google Sheets
function extractSpreadsheetId(url) {
  if (!url) return ''
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return m ? m[1] : String(url).trim()
}

module.exports = {
  isConfigured, getAuthUrl, exchangeCode, refreshAccessToken, getUserEmail,
  saveIntegration, getValidAccessToken,
  readRows, appendRow, updateRange, clearRange, extractSpreadsheetId,
}
