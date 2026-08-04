'use strict'
/**
 * Perfilamiento automático del cliente.
 *
 * Corre en SEGUNDO PLANO después de que el asistente ya respondió (mismo patrón que
 * services/conversationMemory.js), así que no añade latencia a la atención ni contamina
 * lo que el modelo le dice al cliente. Se activa asignando al prompt la herramienta
 * especial "perfilado" (actionType 'profiling'), que a propósito NO expone funciones.
 *
 * Con lo que ve en la conversación, un modelo barato decide:
 *   · una NOTA de contexto sobre el cliente (va a crm_notes y a las notas del ticket),
 *   · qué ETIQUETAS del CRM aplicarle (usa su descripción para saber cuándo aplican),
 *   · a qué ETAPA del pipeline moverlo,
 *   · qué DATOS guardar en variables de la cuenta.
 *
 * Solo AÑADE: nunca borra etiquetas, notas ni datos que ya existieran.
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const { chat } = require('./aiClient')
const store = require('../flow/store')

const MAX_NOTE_CHARS = 1200

// Modelo barato (cuenta → plataforma), igual que la memoria de conversación.
async function resolveModel(accId) {
  try {
    const [[acc]] = await pool.query('SELECT openai_key, deepseek_key FROM accounts WHERE id=?', [accId])
    const [[pf]]  = await pool.query('SELECT openai_key, deepseek_key FROM platform_settings WHERE id=1')
    const openai = (acc?.openai_key || '').trim() || (pf?.openai_key || '')
    if (openai) return { provider: 'openai', model: 'gpt-4o-mini', apiKey: openai }
    const ds = (acc?.deepseek_key || '').trim() || (pf?.deepseek_key || '')
    if (ds) return { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: ds }
  } catch { /* sin key */ }
  return { apiKey: '' }
}

// Tarjeta de pipeline vinculada a la conversación (si la hay) + su pipeline.
async function findCard(accId, convId) {
  try {
    const [rows] = await pool.query('SELECT id, name, stages, cards FROM pipelines WHERE account_id=?', [accId])
    for (const p of rows) {
      const cards = parseJ(p.cards, [])
      const card = cards.find(c => c.convId === convId)
      if (card) return { pipelineId: p.id, pipelineName: p.name, stages: parseJ(p.stages, []), card, cards }
    }
  } catch { /* sin pipelines */ }
  return null
}

const SYS = `Eres el módulo de PERFILAMIENTO de un CRM. Analizas la conversación y extraes SOLO lo que se puede afirmar con evidencia.

Devuelve ÚNICAMENTE un objeto JSON válido (sin texto alrededor, sin markdown) con esta forma:
{
  "nota": "1-3 frases con lo relevante del cliente para un asesor humano. Cadena vacía si no hay nada nuevo.",
  "etiquetas": ["nombre exacto de una etiqueta de la lista"],
  "etapa": "nombre exacto de una etapa de la lista, o cadena vacía si no debe moverse",
  "variables": { "nombre_de_variable": "valor" }
}

Reglas estrictas:
- NO inventes. Si un dato no aparece en la conversación, omítelo.
- "etiquetas": solo nombres de la lista dada, y solo si su descripción encaja de verdad. Lista vacía si ninguna aplica.
- "etapa": solo si la conversación muestra CLARAMENTE que el cliente avanzó a esa etapa. Ante la duda, cadena vacía.
- "variables": solo variables de la lista dada y con valores dichos por el cliente.
- La nota es para el equipo, no para el cliente: sé breve y factual.`

/**
 * Perfila una conversación. Best-effort: nunca lanza (se llama fire-and-forget).
 */
async function profileConversation(accId, agId, convId) {
  if (!accId || !convId) return
  const { provider, model, apiKey } = await resolveModel(accId)
  if (!apiKey) return

  // ── Contexto ──
  const [[conv]] = await pool.query('SELECT local_vars, labels FROM conversations WHERE id=? AND account_id=?', [convId, accId])
  if (!conv) return
  const lv = parseJ(conv.local_vars, {})
  const currentLabelIds = parseJ(conv.labels, [])

  const [msgs] = await pool.query('SELECT sender, content FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 16', [convId])
  const transcript = msgs.reverse()
    .filter(m => m.content && String(m.content).trim())
    .map(m => `${m.sender === 'user' ? 'Cliente' : 'Asistente'}: ${String(m.content).slice(0, 500)}`)
    .join('\n')
  if (!transcript) return

  const [labels] = await pool.query('SELECT id, name, description FROM labels WHERE account_id=?', [accId])
  const [variables] = await pool.query("SELECT id, name, description FROM variables WHERE account_id=? AND type='local'", [accId])
  const linked = await findCard(accId, convId)

  const labelMenu = labels.length
    ? labels.map(l => `- ${l.name}${l.description ? `: ${l.description}` : ''}`).join('\n')
    : '(ninguna)'
  const stageMenu = linked?.stages?.length
    ? [...linked.stages].sort((a, b) => (a.order || 0) - (b.order || 0)).map(s => `- ${s.name}`).join('\n')
    : '(la conversación no tiene ticket en un pipeline)'
  const varMenu = variables.length
    ? variables.map(v => `- ${v.name}${v.description ? `: ${v.description}` : ''}`).join('\n')
    : '(ninguna)'

  const user = `MEMORIA ACTUAL DEL CLIENTE:\n${lv._summary || '(vacía)'}\n\n` +
    `ETIQUETAS DISPONIBLES (aplica solo si la descripción encaja):\n${labelMenu}\n\n` +
    `ETAPAS DEL PIPELINE${linked ? ` "${linked.pipelineName}"` : ''} (etapa actual: ${linked ? (linked.stages.find(s => s.id === linked.card.stageId)?.name || '?') : 'n/a'}):\n${stageMenu}\n\n` +
    `VARIABLES QUE SE PUEDEN RELLENAR:\n${varMenu}\n\n` +
    `CONVERSACIÓN RECIENTE:\n${transcript}`

  let out
  try {
    out = await chat({
      provider, model, apiKey,
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }],
      maxTokens: 700, temperature: 0.2,
      onUsage: u => {
        try {
          store.recordTokenUsage(accId, {
            agentId: agId, conversationId: convId, provider, model,
            promptTokens: u?.promptTokens, completionTokens: u?.completionTokens,
            source: 'profiling',
          })
        } catch {}
      },
    })
  } catch { return }

  const parsed = extractJson(typeof out === 'string' ? out : '')
  if (!parsed) return

  // ── Escrituras (cada una aislada: si una falla, las demás siguen) ──
  const nota = String(parsed.nota || '').trim().slice(0, MAX_NOTE_CHARS)
  if (nota) {
    // Nota en el CRM, asociada a la conversación.
    try {
      await pool.query(
        `INSERT INTO crm_notes (id,account_id,target_type,target_id,author_id,author_name,content,ts)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['note_' + uid(), accId, 'conversation', convId, 'ia', 'Perfilado IA', nota, Date.now()]
      )
    } catch { /* no crítico */ }
  }

  // Etiquetas: por NOMBRE (el modelo solo ve nombres) → id para la conversación, nombre para el ticket.
  const wanted = Array.isArray(parsed.etiquetas) ? parsed.etiquetas.filter(x => typeof x === 'string') : []
  const matched = wanted
    .map(n => labels.find(l => l.name.toLowerCase() === String(n).trim().toLowerCase()))
    .filter(Boolean)
  if (matched.length) {
    try {
      const nextIds = [...new Set([...currentLabelIds, ...matched.map(l => l.id)])]
      if (nextIds.length !== currentLabelIds.length) {
        await store.updateConvo(accId, agId, convId, { labels: nextIds })
      }
    } catch { /* no crítico */ }
  }

  // Ticket vinculado: nota, etiquetas y etapa.
  if (linked) {
    try {
      const patch = {}
      if (nota) patch.notes = [linked.card.notes, `[IA] ${nota}`].filter(Boolean).join('\n')
      if (matched.length) {
        const cur = Array.isArray(linked.card.tags) ? linked.card.tags : []
        const next = [...new Set([...cur, ...matched.map(l => l.name)])]
        if (next.length !== cur.length) patch.tags = next
      }
      const stageName = String(parsed.etapa || '').trim()
      if (stageName) {
        const st = linked.stages.find(s => s.name.toLowerCase() === stageName.toLowerCase())
        if (st && st.id !== linked.card.stageId) patch.stageId = st.id
      }
      if (Object.keys(patch).length) await patchCard(accId, linked, patch)
    } catch { /* no crítico */ }
  }

  // Variables de la conversación.
  if (parsed.variables && typeof parsed.variables === 'object') {
    for (const [name, value] of Object.entries(parsed.variables)) {
      const def = variables.find(v => v.name.toLowerCase() === String(name).trim().toLowerCase())
      if (!def || value == null || String(value).trim() === '') continue
      try { await store.setLocalVar(accId, agId, convId, def.id, String(value).slice(0, 500)) } catch {}
    }
  }
}

// Aplica cambios sobre la tarjeta dentro del JSON `pipelines.cards`.
async function patchCard(accId, linked, patch) {
  const cards = linked.cards.map(c => c.id === linked.card.id
    ? { ...c, ...patch, ...(patch.stageId ? { movedAt: Date.now() } : {}), updatedAt: Date.now() }
    : c)
  await pool.query('UPDATE pipelines SET cards=? WHERE id=? AND account_id=?', [JSON.stringify(cards), linked.pipelineId, accId])
  try { require('./socket').emit(accId, 'account:updated', { accId }) } catch {}
}

// Extrae el JSON de la respuesta aunque venga con texto o vallas markdown alrededor.
function extractJson(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { try { return JSON.parse(fence[1].trim()) } catch {} }
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)) } catch {} }
  return null
}

module.exports = { profileConversation }
