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

const DEFAULT_REDIRECT = 'https://platform.aviasistente.com/api/google/callback'
// Una sola app OAuth cubre Sheets Y Calendar (basta con habilitar ambas APIs en el
// proyecto de Google Cloud y pedir estos scopes).
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',     // eventos + freeBusy (sync de calendarios)
  'https://www.googleapis.com/auth/userinfo.email',
]

// Credenciales OAuth de la plataforma: PRIORIDAD platform_settings (super admin) →
// variables de entorno (compat). Se cachean unos segundos para no consultar la BD
// en cada refresco de token.
let _credCache = null, _credAt = 0
async function getCreds() {
  if (_credCache && Date.now() - _credAt < 30000) return _credCache
  let id = process.env.GOOGLE_CLIENT_ID || ''
  let secret = process.env.GOOGLE_CLIENT_SECRET || ''
  let redirect = process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT
  try {
    const [[r]] = await pool.query('SELECT google_client_id, google_client_secret, google_redirect_uri FROM platform_settings WHERE id=1')
    if (r?.google_client_id && String(r.google_client_id).trim())         id = String(r.google_client_id).trim()
    if (r?.google_client_secret && String(r.google_client_secret).trim()) secret = String(r.google_client_secret).trim()
    if (r?.google_redirect_uri && String(r.google_redirect_uri).trim())   redirect = String(r.google_redirect_uri).trim()
  } catch { /* usa env */ }
  _credCache = { id, secret, redirect }; _credAt = Date.now()
  return _credCache
}
// Invalida la caché cuando el super admin cambia las credenciales.
function invalidateCredsCache() { _credCache = null; _credAt = 0 }

async function isConfigured() { const c = await getCreds(); return !!(c.id && c.secret) }

// URL de consentimiento. state = accId para saber a qué cuenta vincular.
async function getAuthUrl(accId) {
  const c = await getCreds()
  const params = new URLSearchParams({
    client_id: c.id,
    redirect_uri: c.redirect,
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
  const c = await getCreds()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: c.id, client_secret: c.secret,
      redirect_uri: c.redirect, grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error('Intercambio de código falló: ' + (await res.text()).slice(0, 200))
  return res.json() // { access_token, refresh_token, expires_in, scope, id_token }
}

async function refreshAccessToken(refreshToken) {
  const c = await getCreds()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.id, client_secret: c.secret,
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

// ── Helpers de columnas/filtrado ────────────────────────────────────────────
// Convierte filas crudas (incluida la cabecera) en registros {columna: valor}.
// La PRIMERA fila se toma como nombres de columna (encabezados).
function rowsToRecords(rows) {
  const headers = (rows?.[0] || []).map(h => String(h))
  const records = (rows || []).slice(1).map(r => {
    const o = {}
    headers.forEach((h, i) => { o[h] = r[i] ?? '' })
    return o
  })
  return { headers, records }
}

// Filtra filas por el valor de una columna (encabezado). Coincidencia
// insensible a mayúsculas y espacios. Si no se pasa columna/valor, devuelve todo.
// Devuelve { headers, rows (filas de datos crudas que coinciden), records, matched, error? }
function filterSheetRows(rows, matchColumn, matchValue) {
  const headers = (rows?.[0] || []).map(h => String(h))
  const dataRows = (rows || []).slice(1)
  const toRecords = list => list.map(r => {
    const o = {}; headers.forEach((h, i) => { o[h] = r[i] ?? '' }); return o
  })
  const hasFilter = matchColumn != null && String(matchColumn).trim() !== '' &&
                    matchValue  != null && String(matchValue).trim()  !== ''
  if (!hasFilter) {
    return { headers, rows: dataRows, records: toRecords(dataRows), matched: dataRows.length }
  }
  const want = String(matchColumn).trim().toLowerCase()
  const colIdx = headers.findIndex(h => h.trim().toLowerCase() === want)
  if (colIdx === -1) {
    return { headers, rows: [], records: [], matched: 0, error: `Columna "${matchColumn}" no encontrada en la cabecera` }
  }
  const target = String(matchValue).trim().toLowerCase()
  const matchedRows = dataRows.filter(r => String(r[colIdx] ?? '').trim().toLowerCase() === target)
  return { headers, rows: matchedRows, records: toRecords(matchedRows), matched: matchedRows.length }
}

// ── Operación de alto nivel (acciones del nodo de flujo) ─────────────────────
// Centraliza la lógica para que el endpoint HTTP (pruebas/webchat) y el nodo de
// canal usen exactamente el mismo comportamiento.

function quoteSheet(name) { return `'${String(name).replace(/'/g, "''")}'` }

// Convierte índice de columna (1-based) en letra A1: 1→A, 27→AA
function colLetter(n) {
  let s = ''
  let x = Number(n) || 1
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26) }
  return s || 'A'
}

function recordsOf(headers, dataRows) {
  return dataRows.map(r => {
    const o = {}; headers.forEach((h, i) => { o[h] = r[i] ?? '' }); return o
  })
}

// Resuelve los índices de columna de una lista de filtros [{column,value}].
function resolveFilters(headers, filters) {
  const list = (Array.isArray(filters) ? filters : [])
    .filter(f => f && String(f.column ?? '').trim() !== '')
  return list.map(f => {
    const idx = headers.findIndex(h => h.trim().toLowerCase() === String(f.column).trim().toLowerCase())
    if (idx === -1) throw new Error(`Columna "${f.column}" no encontrada en la cabecera`)
    return { idx, value: String(f.value ?? '').trim().toLowerCase(), column: f.column }
  })
}

function rowMatches(row, resolved) {
  return resolved.every(rf => String(row[rf.idx] ?? '').trim().toLowerCase() === rf.value)
}

// Construye una fila alineada a la cabecera a partir de un mapa {columna: valor}.
function buildRowFromMap(headers, fieldMap = {}) {
  const keyFor = h => Object.keys(fieldMap).find(k => k.toLowerCase() === String(h).toLowerCase())
  if (headers.length) return headers.map(h => { const k = keyFor(h); return k != null ? (fieldMap[k] ?? '') : '' })
  return Object.values(fieldMap).map(v => v ?? '')
}

// Mezcla una fila existente con los valores del mapa (solo cambia las columnas mapeadas).
function mergeRow(headers, existing = [], fieldMap = {}) {
  const keyFor = h => Object.keys(fieldMap).find(k => k.toLowerCase() === String(h).toLowerCase())
  return headers.map((h, i) => { const k = keyFor(h); return k != null ? (fieldMap[k] ?? '') : (existing[i] ?? '') })
}

async function runSheetsOperation(token, opts = {}) {
  const op = opts.operation || 'read'
  const spreadsheetId = opts.spreadsheetId
  if (!spreadsheetId) throw new Error('Falta el ID de la hoja')
  const worksheet = opts.worksheet ? String(opts.worksheet) : ''
  const sheetPrefix = worksheet ? `${quoteSheet(worksheet)}!` : ''
  const wholeRange = worksheet ? quoteSheet(worksheet) : (opts.range || 'A1:Z10000')

  // Lista de pestañas (hojas de trabajo) del libro
  if (op === 'worksheets') {
    const meta = await sheetsApi(token, `${spreadsheetId}?fields=sheets.properties.title`)
    return { sheets: (meta.sheets || []).map(sh => sh.properties?.title).filter(Boolean) }
  }

  // Cabeceras (primera fila) de la hoja/pestaña
  if (op === 'headers') {
    const rows = await readRows(token, spreadsheetId, wholeRange)
    return { headers: (rows[0] || []).map(h => String(h)) }
  }

  // Obtener / filtrar filas
  if (op === 'read' || op === 'get_rows' || op === 'get_row') {
    const rows = await readRows(token, spreadsheetId, wholeRange)
    const headers = (rows[0] || []).map(h => String(h))
    const dataRows = rows.slice(1)
    const resolved = resolveFilters(headers, opts.filters)
    let matched = resolved.length ? dataRows.filter(r => rowMatches(r, resolved)) : dataRows
    const limit = op === 'get_row' ? 1 : (Number(opts.limit) || 0)
    if (limit > 0) matched = matched.slice(0, limit)
    return { headers, rows: matched, records: recordsOf(headers, matched), matched: matched.length }
  }

  // Enviar datos (agregar fila al final)
  if (op === 'send' || op === 'append') {
    const rows = await readRows(token, spreadsheetId, wholeRange)
    const headers = (rows[0] || []).map(h => String(h))
    const rowArr = buildRowFromMap(headers, opts.fieldMap || {})
    await appendRow(token, spreadsheetId, wholeRange, rowArr)
    return { ok: true, appended: rowArr, headers }
  }

  // Actualizar fila (la primera que coincide con los filtros)
  if (op === 'update') {
    const rows = await readRows(token, spreadsheetId, wholeRange)
    const headers = (rows[0] || []).map(h => String(h))
    const resolved = resolveFilters(headers, opts.filters)
    if (!resolved.length) throw new Error('Añade al menos un filtro para identificar la fila a actualizar')
    let idx = -1
    for (let i = 1; i < rows.length; i++) { if (rowMatches(rows[i] || [], resolved)) { idx = i; break } }
    if (idx === -1) return { ok: false, error: 'No se encontró ninguna fila que coincida con los filtros', matched: 0 }
    const merged = mergeRow(headers, rows[idx] || [], opts.fieldMap || {})
    const rowNumber = idx + 1
    const updRange = `${sheetPrefix}A${rowNumber}:${colLetter(headers.length || merged.length)}${rowNumber}`
    await updateRange(token, spreadsheetId, updRange, merged)
    return { ok: true, updated: merged, row: rowNumber, matched: 1, headers }
  }

  // Eliminar contenido de la fila que coincide con los filtros
  if (op === 'delete') {
    const rows = await readRows(token, spreadsheetId, wholeRange)
    const headers = (rows[0] || []).map(h => String(h))
    const resolved = resolveFilters(headers, opts.filters)
    if (!resolved.length) throw new Error('Añade al menos un filtro para identificar la fila a eliminar')
    let idx = -1
    for (let i = 1; i < rows.length; i++) { if (rowMatches(rows[i] || [], resolved)) { idx = i; break } }
    if (idx === -1) return { ok: false, error: 'No se encontró ninguna fila que coincida con los filtros', matched: 0 }
    const rowNumber = idx + 1
    await clearRange(token, spreadsheetId, `${sheetPrefix}A${rowNumber}:${colLetter(headers.length || 26)}${rowNumber}`)
    return { ok: true, cleared: rowNumber, matched: 1 }
  }

  throw new Error('Operación de Sheets no soportada: ' + op)
}

// ── Google Calendar API ──────────────────────────────────────────────────────
const CALENDAR = 'https://www.googleapis.com/calendar/v3'
async function calApi(token, path, { method = 'GET', body, qs } = {}) {
  const url = `${CALENDAR}/${path}${qs ? '?' + new URLSearchParams(qs).toString() : ''}`
  const res = await fetch(url, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `Calendar HTTP ${res.status}`)
  return data
}
function createCalendarEvent(token, calendarId, event) {
  return calApi(token, `calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: event })
}
function updateCalendarEvent(token, calendarId, eventId, event) {
  return calApi(token, `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: event })
}
async function deleteCalendarEvent(token, calendarId, eventId) {
  const url = `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Calendar delete HTTP ${res.status}`)
  return true
}
async function freeBusy(token, calendarId, timeMinIso, timeMaxIso) {
  const data = await calApi(token, 'freeBusy', { method: 'POST', body: { timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }] } })
  return data?.calendars?.[calendarId]?.busy || []
}

// ── Push (webhook en tiempo real) — events.watch / channels.stop / sync incremental ──
// Registra un canal de notificaciones push: Google hará POST al `address` cuando el
// calendario cambie. Devuelve { id, resourceId, expiration }.
async function watchEvents(token, calendarId, { id, address, channelToken, ttlSeconds = 7 * 86400 }) {
  return calApi(token, `calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: 'POST', body: { id, type: 'web_hook', address, token: channelToken, params: { ttl: String(ttlSeconds) } },
  })
}
async function stopChannel(token, id, resourceId) {
  try { await calApi(token, 'channels/stop', { method: 'POST', body: { id, resourceId } }) } catch { /* best-effort */ }
}
// Obtiene un syncToken base (solo eventos recientes/futuros, para no paginar todo el historial).
async function getInitialSyncToken(token, calendarId) {
  let pageToken, syncToken, guard = 0
  do {
    const qs = { singleEvents: 'true', showDeleted: 'true', maxResults: '2500', timeMin: new Date(Date.now() - 86400000).toISOString() }
    if (pageToken) qs.pageToken = pageToken
    const data = await calApi(token, `calendars/${encodeURIComponent(calendarId)}/events`, { qs })
    syncToken = data.nextSyncToken || syncToken
    pageToken = data.nextPageToken
  } while (pageToken && ++guard < 25)
  return syncToken || null
}
// Cambios desde el último syncToken. Si el token caducó (410) → { expired:true }.
async function listChanges(token, calendarId, syncToken) {
  if (!syncToken) return { items: [], nextSyncToken: null, expired: true }
  const items = []
  let pageToken, nextSyncToken, guard = 0
  do {
    const qs = { syncToken, maxResults: '2500' }
    if (pageToken) qs.pageToken = pageToken
    let data
    try { data = await calApi(token, `calendars/${encodeURIComponent(calendarId)}/events`, { qs }) }
    catch (e) { if (/410|sync token|expired|GONE/i.test(e.message)) return { items: [], nextSyncToken: null, expired: true }; throw e }
    items.push(...(data.items || []))
    nextSyncToken = data.nextSyncToken || nextSyncToken
    pageToken = data.nextPageToken
  } while (pageToken && ++guard < 25)
  return { items, nextSyncToken, expired: false }
}

module.exports = {
  isConfigured, getAuthUrl, exchangeCode, refreshAccessToken, getUserEmail, invalidateCredsCache,
  saveIntegration, getValidAccessToken,
  readRows, appendRow, updateRange, clearRange, extractSpreadsheetId,
  rowsToRecords, filterSheetRows, runSheetsOperation,
  createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, freeBusy,
  watchEvents, stopChannel, getInitialSyncToken, listChanges,
}
