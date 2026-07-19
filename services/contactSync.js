'use strict'
/**
 * Anclaje de las variables base del lead (nombre / teléfono / email) al contacto del
 * CRM: cuando esas variables de sistema cambian en una conversación vinculada a un
 * contacto (local_vars.contact_id), se refleja el cambio en el contacto. Así "modificar
 * la variable → modifica el dato en el lead".
 *
 * Se aceptan varios alias de nombre de variable (nombre/var_nombre/user_name…) para que
 * funcione sin importar a cuál mapeó el usuario (agenda, herramientas IA, edición manual).
 */
const pool = require('../db')

const NAME_KEYS = ['nombre', 'var_nombre', 'user_name', 'cliente_nombre', 'nombre_cliente', 'nombre_lead']
const PHONE_KEYS = ['telefono', 'teléfono', 'var_telefono', 'user_phone', 'cliente_telefono', 'celular', 'whatsapp', 'telefono_cliente']
const EMAIL_KEYS = ['email', 'correo', 'var_email', 'user_email', 'cliente_email', 'correo_electronico', 'email_cliente']
const CONTACT_FIELD_KEYS = { name: NAME_KEYS, phone: PHONE_KEYS, email: EMAIL_KEYS }

function contactFieldForVar(varId) {
  const k = String(varId || '').toLowerCase()
  if (NAME_KEYS.includes(k)) return 'name'
  if (PHONE_KEYS.includes(k)) return 'phone'
  if (EMAIL_KEYS.includes(k)) return 'email'
  return null
}
const isBoundVar = varId => !!contactFieldForVar(varId)

function pick(lv, keys) {
  for (const key of keys) { const v = lv?.[key]; if (v != null && String(v).trim() !== '') return String(v).trim() }
  return null
}

// Sincroniza el contacto (lead) con las variables ancladas de la conversación.
// `only`: lista de campos a sincronizar (p. ej. ['name'] cuando solo cambió una variable).
async function syncContactFromVars(accId, lv, only = null) {
  if (!lv) return false
  const values = {}
  for (const [field, keys] of Object.entries(CONTACT_FIELD_KEYS)) {
    if (only && !only.includes(field)) continue
    const v = pick(lv, keys)
    if (v != null) values[field] = v
  }
  if (!Object.keys(values).length) return false

  // Contacto por vínculo directo; si no hay, se intenta por coincidencia de teléfono.
  let contactId = lv.contact_id || null
  if (!contactId) {
    const digits = String(values.phone || pick(lv, PHONE_KEYS) || '').replace(/[^\d]/g, '')
    if (digits.length >= 8) {
      try {
        const [[c]] = await pool.query("SELECT id FROM contacts WHERE account_id=? AND REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-','') LIKE ? ORDER BY created_at DESC LIMIT 1", [accId, `%${digits.slice(-9)}`])
        if (c) contactId = c.id
      } catch { /* best-effort */ }
    }
  }
  if (!contactId) return false

  const sets = [], vals = []
  for (const [field, v] of Object.entries(values)) { sets.push(`${field}=?`); vals.push(v) }
  vals.push(contactId, accId)
  try { await pool.query(`UPDATE contacts SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals); return true }
  catch { return false }
}

// Dirección inversa: al editar el contacto (CRM o panel del chat) refleja nombre/teléfono/
// email en TODAS sus conversaciones — guest_name (nombre visible del chat) + las variables
// ancladas de local_vars — para que el lead sea el mismo en todos lados. Best-effort.
async function syncConversationsFromContact(accId, contactId, fields = {}) {
  if (!contactId) return false
  const has = k => fields[k] !== undefined && fields[k] !== null
  if (!has('name') && !has('phone') && !has('email')) return false
  try {
    const [rows] = await pool.query(
      "SELECT id, guest_name, local_vars FROM conversations WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars,'$.contact_id'))=?",
      [accId, contactId]
    )
    for (const c of rows) {
      const lv = (() => { try { return JSON.parse(c.local_vars) || {} } catch { return {} } })()
      if (has('name')) for (const k of ['var_nombre', 'nombre', 'user_name']) lv[k] = String(fields.name)
      if (has('phone')) for (const k of ['var_telefono', 'telefono', 'user_phone']) lv[k] = String(fields.phone)
      if (has('email')) for (const k of ['var_email', 'email', 'user_email']) lv[k] = String(fields.email)
      const sets = ['local_vars=?']; const vals = [JSON.stringify(lv)]
      if (has('name') && String(fields.name).trim()) { sets.push('guest_name=?'); vals.push(String(fields.name)) }
      vals.push(c.id, accId)
      await pool.query(`UPDATE conversations SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals).catch(() => {})
    }
    return true
  } catch { return false }
}

module.exports = { syncContactFromVars, syncConversationsFromContact, isBoundVar, contactFieldForVar, NAME_KEYS, PHONE_KEYS, EMAIL_KEYS }
