'use strict'
/**
 * Alias de las variables base del usuario/lead/contacto/chat. La variable CANÓNICA (la
 * primera de cada grupo) es la que se debe usar en toda la plataforma:
 *   nombre → user_name · email → user_email · teléfono → user_phone
 * El resto son alias históricos que se siguen resolviendo para no romper contenido viejo
 * (prompts, flujos, plantillas) que aún use {{var_nombre}}, {{nombre}}, {{cliente_nombre}}…
 */

// Canónica primero en cada grupo.
const ALIAS_GROUPS = {
  name: ['user_name', 'var_nombre', 'nombre', 'cliente_nombre', 'nombre_cliente', 'nombre_lead'],
  email: ['user_email', 'var_email', 'email', 'correo', 'cliente_email', 'correo_electronico', 'email_cliente'],
  phone: ['user_phone', 'var_telefono', 'telefono', 'teléfono', 'celular', 'whatsapp', 'cliente_telefono', 'telefono_cliente'],
}

// clave (lower) → nombre del grupo al que pertenece.
const KEY_TO_GROUP = {}
for (const [group, keys] of Object.entries(ALIAS_GROUPS)) for (const k of keys) KEY_TO_GROUP[k.toLowerCase()] = group

const nonEmpty = v => v !== undefined && v !== null && String(v).trim() !== ''

// Resuelve una variable con fallback por alias: si `vars[key]` está vacía y la clave es un
// alias de nombre/email/teléfono, devuelve el primer alias NO vacío del mismo grupo. Si no
// pertenece a ningún grupo (o nada tiene valor), devuelve `vars[key]` tal cual (o undefined).
function resolveVar(vars, key) {
  if (!vars) return undefined
  const direct = vars[key]
  if (nonEmpty(direct)) return direct
  const group = KEY_TO_GROUP[String(key || '').toLowerCase()]
  if (!group) return direct
  for (const alias of ALIAS_GROUPS[group]) {
    const v = vars[alias]
    if (nonEmpty(v)) return v
  }
  return direct
}

module.exports = { ALIAS_GROUPS, KEY_TO_GROUP, resolveVar, nonEmpty }
