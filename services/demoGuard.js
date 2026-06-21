'use strict'
/**
 * Antifraude de cuentas Demo (Fase 5).
 * Valida 4 factores antes de permitir crear una cuenta Demo: correo, IP (12 meses),
 * huella de dispositivo (fingerprint) y teléfono. Registra TODOS los intentos
 * (creados y bloqueados) para auditoría/reportes de fraude. El SuperAdmin puede
 * crear "overrides" (excepciones) por identificador o desactivar la regla de IP.
 */
const pool = require('../db')
const { uid } = require('../utils')

const YEAR = 365 * 24 * 60 * 60 * 1000

const MSG = {
  email: 'Ya existe una cuenta Demo asociada a este correo electrónico.',
  ip: 'Ya se ha utilizado una cuenta Demo desde esta conexión a internet.',
  fingerprint: 'Este dispositivo ya ha utilizado una cuenta Demo anteriormente.',
  phone: 'Este número ya fue utilizado para una cuenta Demo.',
}

const normEmail = s => String(s || '').trim().toLowerCase()
const digits = s => String(s || '').replace(/[^\d]/g, '')

async function usedDemo(col, val) {
  if (!val) return false
  const [[r]] = await pool.query(
    `SELECT 1 AS x FROM demo_registrations WHERE ${col}=? AND result IN ('created','created_override') LIMIT 1`, [val]
  )
  return !!r
}
async function usedIpWithinYear(ip) {
  if (!ip) return false
  const [[r]] = await pool.query(
    "SELECT 1 AS x FROM demo_registrations WHERE ip=? AND result IN ('created','created_override') AND created_at > ? LIMIT 1",
    [ip, Date.now() - YEAR]
  )
  return !!r
}

// Valida un intento de Demo. Devuelve { ok, result, message, overrideIds, ipOff }.
async function validate({ email, ip, fingerprint, phone }) {
  email = normEmail(email); phone = digits(phone)
  const [ovs] = await pool.query('SELECT * FROM demo_overrides WHERE used=0')
  const ipOff = ovs.some(o => o.kind === 'global_ip_off')
  const findOv = (kind, val) => val ? ovs.find(o => o.kind === kind && o.value === val) : null

  if (email && !findOv('email', email) && await usedDemo('email', email))
    return { ok: false, result: 'blocked_email', message: MSG.email }
  if (ip && !ipOff && !findOv('ip', ip) && await usedIpWithinYear(ip))
    return { ok: false, result: 'blocked_ip', message: MSG.ip }
  if (fingerprint && !findOv('fingerprint', fingerprint) && await usedDemo('fingerprint', fingerprint))
    return { ok: false, result: 'blocked_fingerprint', message: MSG.fingerprint }
  if (phone && !findOv('phone', phone) && await usedDemo('phone', phone))
    return { ok: false, result: 'blocked_phone', message: MSG.phone }

  const overrideIds = ['email', 'ip', 'fingerprint', 'phone']
    .map(k => findOv(k, k === 'email' ? email : k === 'ip' ? ip : k === 'fingerprint' ? fingerprint : phone))
    .filter(Boolean).map(o => o.id)
  return { ok: true, overrideIds, ipOff }
}

async function recordAttempt({ accountId = null, email, ip, fingerprint, phone, result, reason = null, expiresAt = null,
                               company = null, country = null, industry = null, iaName = null, onboarding = null }) {
  await pool.query(
    `INSERT INTO demo_registrations (id,account_id,email,ip,fingerprint,phone,result,reason,status,created_at,expires_at,
       company,country,industry,ia_name,onboarding)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['dreg_' + uid(), accountId, normEmail(email), ip || null, fingerprint || null, digits(phone) || null,
     result, reason, result.startsWith('created') ? 'active' : 'blocked', Date.now(), expiresAt,
     company || null, country || null, industry || null, iaName || null, onboarding ? JSON.stringify(onboarding) : null]
  )
}

async function consumeOverrides(ids = []) {
  if (!ids.length) return
  await pool.query(`UPDATE demo_overrides SET used=1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
}

// ── Gestión (superadmin) ───────────────────────────────────────────────────────
async function listRegistrations({ limit = 200, result, q } = {}) {
  let sql = 'SELECT * FROM demo_registrations'
  const where = [], vals = []
  if (result) { where.push('result=?'); vals.push(result) }
  if (q) { where.push('(email LIKE ? OR ip LIKE ? OR fingerprint LIKE ? OR phone LIKE ?)'); const v = `%${q}%`; vals.push(v, v, v, v) }
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY created_at DESC LIMIT ?'; vals.push(Number(limit) || 200)
  const [rows] = await pool.query(sql, vals)
  return rows
}
async function listOverrides() {
  const [rows] = await pool.query('SELECT * FROM demo_overrides ORDER BY created_at DESC')
  return rows
}
async function addOverride(kind, value, note, by) {
  const id = 'dov_' + uid()
  await pool.query('INSERT INTO demo_overrides (id,kind,value,note,used,created_by,created_at) VALUES (?,?,?,?,0,?,?)',
    [id, kind, value || null, note || null, by || 'superadmin', Date.now()])
  return id
}
async function removeOverride(id) { await pool.query('DELETE FROM demo_overrides WHERE id=?', [id]) }
// Permite una nueva Demo / reinicia restricciones para los identificadores dados.
async function allow({ email, ip, fingerprint, phone, note }, by) {
  const added = []
  if (email)       added.push(await addOverride('email', normEmail(email), note, by))
  if (ip)          added.push(await addOverride('ip', ip, note, by))
  if (fingerprint) added.push(await addOverride('fingerprint', fingerprint, note, by))
  if (phone)       added.push(await addOverride('phone', digits(phone), note, by))
  return added
}
async function setIpRestriction(enabled, by) {
  // enabled=false → existe override global_ip_off; enabled=true → se elimina.
  await pool.query("DELETE FROM demo_overrides WHERE kind='global_ip_off'")
  if (!enabled) await addOverride('global_ip_off', 'all', 'IP check deshabilitado', by)
}
async function ipRestrictionEnabled() {
  const [[r]] = await pool.query("SELECT 1 AS x FROM demo_overrides WHERE kind='global_ip_off' AND used=0 LIMIT 1")
  return !r
}

module.exports = {
  MSG, validate, recordAttempt, consumeOverrides,
  listRegistrations, listOverrides, addOverride, removeOverride, allow, setIpRestriction, ipRestrictionEnabled,
}
