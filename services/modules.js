'use strict'
/**
 * Módulos de cuenta — segundo eje de control (además de los permisos de rol).
 *
 * Un módulo representa una "funcionalidad" que la cuenta tiene derecho a usar.
 * Debe ser activado por un superadmin (o pagado, en el futuro). El eje de
 * permisos de rol sigue existiendo: una sección se ve si el ROL tiene permiso
 * Y el módulo está habilitado para la cuenta.
 *
 * Resolución efectiva:
 *   account.modules (override por cuenta) → si null, accountType.modules (preset
 *   del tipo) → si null, TODOS activos (retro-compat: cuentas existentes intactas).
 */
const { parseJ } = require('../utils')

// Registro canónico (el frontend tiene un espejo en src/lib/modules.js).
const MODULES = [
  { id: 'inbox',     name: 'Bandeja',            description: 'Conversaciones entrantes: ver y responder chats.' },
  { id: 'crm',       name: 'CRM y Pipeline',     description: 'Contactos, embudos y gestión comercial.' },
  { id: 'channels',  name: 'Canales',            description: 'Conexión de WhatsApp, Messenger, Instagram y Webchat.' },
  { id: 'campaigns', name: 'Campañas / Masivos', description: 'Envío de mensajes masivos a contactos.' },
  { id: 'flows',     name: 'Flujos',             description: 'Automatizaciones y flujos conversacionales.' },
  { id: 'ai_agents', name: 'Agentes IA',         description: 'Zona IA: prompts, herramientas y variables del agente.' },
  { id: 'knowledge', name: 'Conocimiento (RAG)', description: 'Base de conocimiento para respuestas del agente.' },
  { id: 'calendars', name: 'Agendamiento',       description: 'Calendarios y reservas.' },
  { id: 'metrics',   name: 'Métricas',           description: 'Analítica y reportes de uso.' },
  { id: 'teamchat',  name: 'Chat de equipo',     description: 'Mensajería interna entre el equipo.' },
]
const MODULE_IDS = MODULES.map(m => m.id)

// Normaliza un valor crudo (JSON string | array | objeto-mapa | null) a un Set de
// ids habilitados, o null si no hay definición (= "todos").
function toSet(raw) {
  if (raw == null) return null
  let v = raw
  if (typeof v === 'string') { v = parseJ(v, null); if (v == null) return null }
  if (Array.isArray(v)) return new Set(v.filter(id => MODULE_IDS.includes(id)))
  if (typeof v === 'object') return new Set(MODULE_IDS.filter(id => v[id]))
  return null
}

// Devuelve el mapa efectivo { id: true/false } para TODOS los módulos.
// account gana sobre tipo; si ninguno define nada → todos true.
function resolveModules(accModulesRaw, typeModulesRaw) {
  const set = toSet(accModulesRaw) ?? toSet(typeModulesRaw)
  const map = {}
  for (const id of MODULE_IDS) map[id] = set ? set.has(id) : true
  return map
}

module.exports = { MODULES, MODULE_IDS, resolveModules, toSet }
