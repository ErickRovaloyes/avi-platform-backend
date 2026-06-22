'use strict'
/**
 * Memoria de conversación persistente.
 * Tras cada respuesta del asistente se actualiza un RESUMEN + ESTADO de la
 * conversación combinando la memoria anterior con el intercambio reciente. Se
 * guarda en la CONVERSACIÓN (local_vars._summary) y, sobre todo, en el CONTACTO
 * (contacts.memory) para que sea PERMANENTE y esté disponible en futuras
 * conversaciones con el mismo usuario. El nodo IA la inyecta en el prompt además
 * de los últimos 16 mensajes.
 */
const pool = require('../db')
const { parseJ } = require('../utils')
const { chat } = require('./aiClient')

const MAX_MEMORY_CHARS = 4000

// Modelo barato para resumir (cuenta → plataforma). OpenAI primero, luego DeepSeek.
async function resolveSummaryModel(accId) {
  try {
    const [[acc]] = await pool.query('SELECT openai_key, deepseek_key FROM accounts WHERE id=?', [accId])
    const [[pf]]  = await pool.query('SELECT openai_key, deepseek_key FROM platform_settings WHERE id=1')
    const openai = (acc?.openai_key || '').trim() || (pf?.openai_key || '')
    if (openai) return { provider: 'openai', model: 'gpt-4o-mini', apiKey: openai }
    const ds = (acc?.deepseek_key || '').trim() || (pf?.deepseek_key || '')
    if (ds) return { provider: 'deepseek', model: 'deepseek-chat', apiKey: ds }
  } catch { /* sin key */ }
  return { apiKey: '' }
}

async function getContactMemory(accId, contactId) {
  if (!contactId) return ''
  try { const [[c]] = await pool.query('SELECT memory FROM contacts WHERE id=? AND account_id=?', [contactId, accId]); return c?.memory || '' }
  catch { return '' }
}

const SYS = `Eres el módulo de MEMORIA de un agente de atención/ventas. Mantienes un resumen permanente del cliente y el estado de la conversación.
Actualiza la memoria combinando lo que YA sabías con el intercambio nuevo. Devuelve SOLO la memoria actualizada (sin preámbulos ni comillas), en español, concisa (máx ~1500 caracteres), con estas secciones cuando haya datos reales:
- DATOS DEL CLIENTE: nombre, contacto, ubicación, empresa, etc.
- LO QUE QUIERE / NECESITA
- DATOS IMPORTANTES / PREFERENCIAS / RESTRICCIONES
- DECISIONES Y ACUERDOS (incluye pedidos, montos, fechas)
- PENDIENTES / PRÓXIMO PASO
- ESTADO: etapa actual (saludo / descubrimiento / cotización / cierre / postventa)
Reglas: NO inventes; si un dato no se conoce, omite la línea. CONSERVA los datos importantes de la memoria anterior aunque no se repitan ahora. Sé factual y breve.`

// Actualiza la memoria de una conversación. Best-effort (nunca lanza).
async function updateMemory(accId, agId, convId) {
  try {
    if (!accId || !convId) return
    const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!c) return
    const lv = parseJ(c.local_vars, {})
    const contactId = lv.contact_id || null
    const prev = lv._summary || (contactId ? await getContactMemory(accId, contactId) : '') || ''

    // Transcripción reciente (últimos ~16 mensajes con texto).
    const [rows] = await pool.query("SELECT sender, content FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 16", [convId])
    const transcript = rows.reverse()
      .filter(m => m.content && String(m.content).trim())
      .map(m => `${m.sender === 'user' ? 'Cliente' : 'Asistente'}: ${String(m.content).slice(0, 500)}`)
      .join('\n')
    if (!transcript) return

    const { provider, model, apiKey } = await resolveSummaryModel(accId)
    if (!apiKey) return

    const user = `MEMORIA ANTERIOR:\n${prev || '(vacía)'}\n\nINTERCAMBIO RECIENTE (lo más nuevo al final):\n${transcript}\n\nDevuelve la memoria actualizada.`
    const out = await chat({
      provider, model, apiKey,
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }],
      maxTokens: 700, temperature: 0.2,
    })
    let memory = (typeof out === 'string' ? out : '').trim()
    if (!memory || memory.length < 10) return
    if (memory.length > MAX_MEMORY_CHARS) memory = memory.slice(0, MAX_MEMORY_CHARS)

    // Guardar en la conversación (cache rápido para el nodo IA)…
    lv._summary = memory
    await pool.query('UPDATE conversations SET local_vars=? WHERE id=?', [JSON.stringify(lv), convId])
    // …y en el contacto (PERMANENTE, entre conversaciones).
    if (contactId) await pool.query('UPDATE contacts SET memory=?, memory_updated_at=? WHERE id=? AND account_id=?', [memory, Date.now(), contactId, accId])
  } catch (e) { console.warn('[conv memory]', e.message) }
}

module.exports = { updateMemory, getContactMemory }
