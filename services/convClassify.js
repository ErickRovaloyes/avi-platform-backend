'use strict'
// Clasificación IA de conversaciones (CRM): tema/motivo + sentimiento.
// Usa el "Modelo IA de Negocio" configurable desde el Super Panel (business_ai_model).
// Corre por lotes incrementales (solo las no clasificadas), para controlar costo.
const pool = require('../db')
const { callAI, detectProvider, resolveProviderKey, extractJson } = require('../controllers/promptGenerator.controller')

const TOPICS = ['ventas', 'soporte', 'queja', 'informacion', 'agendamiento', 'pedido', 'otro']
const SENTIMENTS = ['positivo', 'neutral', 'negativo']

const SYS = `Eres un clasificador de conversaciones de atención al cliente de un negocio.
Devuelve SOLO un JSON con dos campos:
{"tema": <uno de: ${TOPICS.join(', ')}>, "sentimiento": <uno de: ${SENTIMENTS.join(', ')}>}
- "tema" = el motivo principal por el que el cliente escribió.
- "sentimiento" = el ánimo general del cliente en la conversación.
No expliques nada, solo el JSON.`

async function businessModel() {
  try {
    const [[ps]] = await pool.query('SELECT business_ai_model FROM platform_settings WHERE id=1')
    return ps?.business_ai_model || 'gpt-4o-mini'
  } catch { return 'gpt-4o-mini' }
}

// Texto compacto de la conversación (primeros mensajes con contenido).
async function convText(convId) {
  const [msgs] = await pool.query('SELECT sender, content FROM messages WHERE conversation_id=? AND content IS NOT NULL AND content<>"" ORDER BY ts ASC LIMIT 20', [convId])
  let out = ''
  for (const m of msgs) {
    const who = m.sender === 'user' || m.sender === 'guest' ? 'Cliente' : 'Negocio'
    out += `${who}: ${String(m.content).slice(0, 400)}\n`
    if (out.length > 2400) break
  }
  return out.trim()
}

// Clasifica hasta `limit` conversaciones sin clasificar de la cuenta. Devuelve conteos.
async function classifyBatch(accId, { limit = 25 } = {}) {
  const model = await businessModel()
  const provider = detectProvider(model)
  const { key: apiKey } = await resolveProviderKey(accId, provider)
  if (!apiKey) return { ok: false, error: `Sin API key para ${provider}. Configúrala en la cuenta o en el Super Panel.` }

  const [rows] = await pool.query(
    `SELECT c.id FROM conversations c
     WHERE c.account_id=? AND c.classified_at IS NULL
       AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content IS NOT NULL AND m.content<>"")
     ORDER BY c.updated_at DESC LIMIT ?`, [accId, limit])
  if (!rows.length) return { ok: true, classified: 0, remaining: 0 }

  let classified = 0
  for (const { id } of rows) {
    try {
      const text = await convText(id)
      if (!text) { await pool.query('UPDATE conversations SET topic=?, sentiment=?, classified_at=? WHERE id=?', ['otro', 'neutral', Date.now(), id]); continue }
      const r = await callAI({ provider, model, apiKey, systemPrompt: SYS, userPrompt: text, maxTokens: 80, temperature: 0, jsonMode: provider !== 'anthropic' })
      const parsed = extractJson(r.text || '') || {}
      const topic = TOPICS.includes(String(parsed.tema || '').toLowerCase()) ? String(parsed.tema).toLowerCase() : 'otro'
      const sentiment = SENTIMENTS.includes(String(parsed.sentimiento || '').toLowerCase()) ? String(parsed.sentimiento).toLowerCase() : 'neutral'
      await pool.query('UPDATE conversations SET topic=?, sentiment=?, classified_at=? WHERE id=?', [topic, sentiment, Date.now(), id])
      classified++
    } catch (e) { /* deja la conversación sin marcar; se reintenta en el próximo lote */ }
  }
  const [[rem]] = await pool.query('SELECT COUNT(*) AS n FROM conversations WHERE account_id=? AND classified_at IS NULL', [accId])
  return { ok: true, classified, remaining: Number(rem?.n || 0), model }
}

module.exports = { classifyBatch, TOPICS, SENTIMENTS }
