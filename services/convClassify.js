'use strict'
// Análisis de conversaciones (CRM):
//  · Clasificación IA: tema/motivo + sentimiento (usa el Modelo IA de Negocio del Super Panel).
//  · Métricas de atención (sin IA): tiempo de 1ª respuesta + desenlace (outcome).
// Corre por lotes incrementales (solo las no analizadas), para controlar costo.
const pool = require('../db')
const { callAI, detectProvider, resolveProviderKey, extractJson } = require('../controllers/promptGenerator.controller')

const TOPICS = ['ventas', 'soporte', 'queja', 'informacion', 'agendamiento', 'pedido', 'otro']
const SENTIMENTS = ['positivo', 'neutral', 'negativo']
const INTENTS = ['nula', 'baja', 'media', 'alta']

const SYS = `Eres un clasificador de conversaciones de atención al cliente de un negocio.
Devuelve SOLO un JSON con tres campos:
{"tema": <uno de: ${TOPICS.join(', ')}>, "sentimiento": <uno de: ${SENTIMENTS.join(', ')}>, "intencion": <uno de: ${INTENTS.join(', ')}>}
- "tema" = el motivo principal por el que el cliente escribió.
- "sentimiento" = el ánimo general del cliente.
- "intencion" = qué tan cerca está el cliente de comprar/contratar (nula = no aplica; alta = quiere comprar ya).
No expliques nada, solo el JSON.`

async function businessModel() {
  try {
    const [[ps]] = await pool.query('SELECT business_ai_model FROM platform_settings WHERE id=1')
    return ps?.business_ai_model || 'gpt-4o-mini'
  } catch { return 'gpt-4o-mini' }
}

// Métricas de atención a partir de los mensajes (cliente='user'; negocio='ai'/'human').
function attentionFrom(msgs, aiEnabled) {
  let firstUserTs = null, firstBizTs = null
  for (const m of msgs) {
    if (m.sender === 'user') { if (firstUserTs == null) firstUserTs = Number(m.ts) }
    else if (firstUserTs != null && firstBizTs == null) firstBizTs = Number(m.ts)
  }
  const frt = (firstUserTs != null && firstBizTs != null && firstBizTs >= firstUserTs) ? (firstBizTs - firstUserTs) : null
  const hasBiz = msgs.some(m => m.sender !== 'user')
  const outcome = aiEnabled === 0 ? 'derivado' : (hasBiz ? 'atendido' : 'sin_respuesta')
  return { frt, outcome }
}

// Clasifica + mide atención de hasta `limit` conversaciones sin analizar. Devuelve conteos.
async function classifyBatch(accId, { limit = 25 } = {}) {
  const model = await businessModel()
  const provider = detectProvider(model)
  const { key: apiKey } = await resolveProviderKey(accId, provider)
  if (!apiKey) return { ok: false, error: `Sin API key para ${provider}. Configúrala en la cuenta o en el Super Panel.` }

  const [rows] = await pool.query(
    `SELECT c.id, c.ai_enabled FROM conversations c
     WHERE c.account_id=? AND c.classified_at IS NULL
       AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content IS NOT NULL AND m.content<>"")
     ORDER BY c.updated_at DESC LIMIT ?`, [accId, limit])
  if (!rows.length) return { ok: true, classified: 0, remaining: 0 }

  let classified = 0
  for (const conv of rows) {
    try {
      const [msgs] = await pool.query('SELECT sender, content, ts FROM messages WHERE conversation_id=? ORDER BY ts ASC LIMIT 40', [conv.id])
      const { frt, outcome } = attentionFrom(msgs, conv.ai_enabled)

      // Texto compacto para la IA.
      let text = ''
      for (const m of msgs) {
        if (!m.content) continue
        text += `${m.sender === 'user' ? 'Cliente' : 'Negocio'}: ${String(m.content).slice(0, 400)}\n`
        if (text.length > 2400) break
      }
      let topic = 'otro', sentiment = 'neutral', intent = 'nula'
      if (text.trim()) {
        const r = await callAI({ provider, model, apiKey, systemPrompt: SYS, userPrompt: text.trim(), maxTokens: 90, temperature: 0, jsonMode: provider !== 'anthropic' })
        const parsed = extractJson(r.text || '') || {}
        topic = TOPICS.includes(String(parsed.tema || '').toLowerCase()) ? String(parsed.tema).toLowerCase() : 'otro'
        sentiment = SENTIMENTS.includes(String(parsed.sentimiento || '').toLowerCase()) ? String(parsed.sentimiento).toLowerCase() : 'neutral'
        intent = INTENTS.includes(String(parsed.intencion || '').toLowerCase()) ? String(parsed.intencion).toLowerCase() : 'nula'
      }
      await pool.query('UPDATE conversations SET topic=?, sentiment=?, buying_intent=?, first_response_ms=?, outcome=?, classified_at=? WHERE id=?',
        [topic, sentiment, intent, frt, outcome, Date.now(), conv.id])
      classified++
    } catch (e) { /* deja la conversación sin marcar; se reintenta en el próximo lote */ }
  }
  const [[rem]] = await pool.query('SELECT COUNT(*) AS n FROM conversations WHERE account_id=? AND classified_at IS NULL', [accId])
  return { ok: true, classified, remaining: Number(rem?.n || 0), model }
}

module.exports = { classifyBatch, TOPICS, SENTIMENTS }
