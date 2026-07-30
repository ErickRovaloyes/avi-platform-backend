'use strict'
// Códigos de verificación de un solo uso (registro / 2FA de login). Se guardan en
// email_codes y se envían por correo. Verificación con expiración + límite de intentos.
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const { sendEmail, renderCodeEmail, loadEmailConfig, isConfigured } = require('./email')

const TTL_MS = 10 * 60 * 1000   // 10 minutos
const MAX_ATTEMPTS = 6

function gen6() { return String(Math.floor(100000 + Math.random() * 900000)) }

// Crea + envía un código. purpose: 'login' | 'signup'. Devuelve { ok, error }.
async function issueCode(email, purpose) {
  const cfg = await loadEmailConfig()
  if (!isConfigured(cfg)) return { ok: false, error: 'Correo no configurado' }
  const code = gen6()
  const now = Date.now()
  try {
    // Invalida códigos previos del mismo email+propósito.
    await pool.query('UPDATE email_codes SET consumed=1 WHERE email=? AND purpose=? AND consumed=0', [email, purpose])
    await pool.query(
      'INSERT INTO email_codes (id,email,code,purpose,expires_at,consumed,attempts,created_at) VALUES (?,?,?,?,?,0,0,?)',
      ['ec_' + uid(), email, code, purpose, now + TTL_MS, now]
    )
  } catch (err) { return { ok: false, error: 'No se pudo generar el código' } }
  // Plantilla editable (Super Panel) + marca de la plataforma.
  let templates = {}, brand = {}
  try {
    const [[s]] = await pool.query('SELECT email_templates, brand_logo, brand_name FROM platform_settings WHERE id=1')
    templates = parseJ(s?.email_templates, {}) || {}
    brand = { name: s?.brand_name || '', logo: s?.brand_logo || '' }
  } catch { /* usa defaults */ }
  const mail = renderCodeEmail(purpose, { code, templates, brand, minutes: Math.round(TTL_MS / 60000) })
  const r = await sendEmail({ to: email, cfg, subject: mail.subject, html: mail.html, text: mail.text })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true }
}

// Verifica (y consume) un código. Devuelve { ok, error }.
async function verifyCode(email, purpose, code) {
  if (!email || !code) return { ok: false, error: 'Faltan datos' }
  try {
    const [[row]] = await pool.query(
      'SELECT * FROM email_codes WHERE email=? AND purpose=? AND consumed=0 ORDER BY created_at DESC LIMIT 1',
      [email, purpose]
    )
    if (!row) return { ok: false, error: 'No hay un código pendiente. Solicita uno nuevo.' }
    if (Date.now() > Number(row.expires_at)) { await pool.query('UPDATE email_codes SET consumed=1 WHERE id=?', [row.id]); return { ok: false, error: 'El código expiró. Solicita uno nuevo.' } }
    if (Number(row.attempts) >= MAX_ATTEMPTS) { await pool.query('UPDATE email_codes SET consumed=1 WHERE id=?', [row.id]); return { ok: false, error: 'Demasiados intentos. Solicita un código nuevo.' } }
    if (String(row.code) !== String(code).trim()) {
      await pool.query('UPDATE email_codes SET attempts=attempts+1 WHERE id=?', [row.id])
      return { ok: false, error: 'Código incorrecto.' }
    }
    await pool.query('UPDATE email_codes SET consumed=1 WHERE id=?', [row.id])
    return { ok: true }
  } catch (err) { return { ok: false, error: 'Error al verificar el código' } }
}

module.exports = { issueCode, verifyCode }
