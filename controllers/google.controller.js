'use strict'
const pool = require('../db')
const { uid } = require('../utils')
const g = require('../services/google')

// GET /api/accounts/:accId/google/status → { connected, email }
const status = async (req, res) => {
  const { accId } = req.params
  try {
    const [[row]] = await pool.query('SELECT email, connected_at FROM google_integrations WHERE account_id=?', [accId])
    res.json({ configured: g.isConfigured(), connected: !!row, email: row?.email || '', connectedAt: row?.connected_at || null })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// GET /api/accounts/:accId/google/auth-url → { url }
const authUrl = async (req, res) => {
  const { accId } = req.params
  if (!g.isConfigured()) return res.status(400).json({ error: 'Google OAuth no está configurado en el servidor (GOOGLE_CLIENT_ID/SECRET).' })
  res.json({ url: g.getAuthUrl(accId) })
}

// GET /api/google/callback?code=&state=accId  (Google redirige aquí)
const callback = async (req, res) => {
  const { code, state: accId, error } = req.query
  const close = (msg, ok) => res.send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0d0d12;color:#ebebf0;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center"><div><h2>${ok ? '✅' : '⚠'} ${msg}</h2><p>Puedes cerrar esta ventana.</p><script>setTimeout(()=>window.close(),2500)</script></div></body>`)
  if (error || !code || !accId) return close('No se pudo conectar con Google', false)
  try {
    const tokens = await g.exchangeCode(code)
    const email = await g.getUserEmail(tokens.access_token)
    await g.saveIntegration(accId, tokens, email)
    close(`Google conectado${email ? ' como ' + email : ''}`, true)
  } catch (e) {
    console.error('[google callback]', e.message)
    close('Error al conectar: ' + e.message, false)
  }
}

// DELETE /api/accounts/:accId/google → desconectar
const disconnect = async (req, res) => {
  const { accId } = req.params
  try {
    await pool.query('DELETE FROM google_integrations WHERE account_id=?', [accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Sheets vinculados (por link) ─────────────────────────────────────────────
const listSheets = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT id, name, spreadsheet_id, url, created_at FROM google_sheets WHERE account_id=? ORDER BY created_at DESC', [accId])
    res.json(rows.map(r => ({ id: r.id, name: r.name, spreadsheetId: r.spreadsheet_id, url: r.url, createdAt: r.created_at })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const addSheet = async (req, res) => {
  const { accId } = req.params
  const { name = '', url = '' } = req.body || {}
  const spreadsheetId = g.extractSpreadsheetId(url)
  if (!spreadsheetId) return res.status(400).json({ error: 'Link de Google Sheet inválido' })
  const id = 'gs_' + uid()
  try {
    await pool.query(
      'INSERT INTO google_sheets (id, account_id, name, spreadsheet_id, url, created_at) VALUES (?,?,?,?,?,?)',
      [id, accId, name || 'Hoja', spreadsheetId, url, Date.now()]
    )
    // Validación opcional: intenta leer la fila 1 para confirmar acceso
    let warning = null
    try {
      const token = await g.getValidAccessToken(accId)
      await g.readRows(token, spreadsheetId, 'A1:A1')
    } catch (e) { warning = 'Vinculada, pero no se pudo leer: ' + e.message + '. Comparte la hoja con tu cuenta de Google conectada.' }
    res.json({ id, spreadsheetId, warning })
  } catch (err) { console.error('[addSheet]', err); res.status(500).json({ error: 'Error interno' }) }
}

const removeSheet = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query('DELETE FROM google_sheets WHERE id=? AND account_id=?', [id, accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// POST /api/accounts/:accId/google/sheets-op
// body: { operation, spreadsheet, worksheet, range, filters, fieldMap, limit }
//   operation: 'worksheets' | 'headers' | 'read'/'get_rows' | 'send'/'append' | 'update' | 'delete'
// Ejecuta la operación de Sheets server-side (usado por el nodo de flujo cuando
// corre en el navegador: pruebas / webchat) con la cuenta de Google conectada.
const sheetsOp = async (req, res) => {
  const { accId } = req.params
  const { operation = 'read', spreadsheet, worksheet, range, filters, fieldMap, limit } = req.body || {}
  try {
    const spreadsheetId = g.extractSpreadsheetId(spreadsheet)
    if (!spreadsheetId) return res.status(400).json({ error: 'Falta el link/ID de la hoja' })
    const token = await g.getValidAccessToken(accId)
    const out = await g.runSheetsOperation(token, { operation, spreadsheetId, worksheet, range, filters, fieldMap, limit })
    return res.json({ ok: true, ...out })
  } catch (e) {
    res.status(502).json({ error: e.message || 'Error de Google Sheets' })
  }
}

module.exports = { status, authUrl, callback, disconnect, listSheets, addSheet, removeSheet, sheetsOp }
