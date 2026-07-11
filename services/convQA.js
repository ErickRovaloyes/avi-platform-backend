'use strict'
// QA del asistente: una IA revisora evalúa la calidad de la atención en conversaciones
// atendidas por la IA y les pone un puntaje (0-100) + el problema detectado. Por lotes.
const pool = require('../db')
const { callAI, detectProvider, resolveProviderKey, extractJson } = require('../controllers/promptGenerator.controller')

const SYS = `Eres un auditor de calidad de atención al cliente. Evalúas cómo respondió el ASISTENTE IA de un negocio en una conversación.
Devuelve SOLO un JSON: {"puntaje": <entero 0-100>, "problema": "<frase corta o vacío>"}.
Criterios: ¿respondió lo que el cliente pidió?, ¿fue claro y útil?, ¿inventó datos (alucinación)?, ¿dejó al cliente sin resolver o lo ignoró?
- puntaje alto (80-100) = excelente atención; bajo (0-40) = mala (no resolvió, confuso o inventó).
- "problema" = el fallo principal si el puntaje es bajo (p. ej. "no respondió la pregunta", "posible dato inventado", "tono cortante"); vacío si todo bien.`

async function businessModel() {
  try { const [[ps]] = await pool.query('SELECT business_ai_model FROM platform_settings WHERE id=1'); return ps?.business_ai_model || 'gpt-4o-mini' }
  catch { return 'gpt-4o-mini' }
}

async function qaBatch(accId, { limit = 15 } = {}) {
  const model = await businessModel()
  const provider = detectProvider(model)
  const { key: apiKey } = await resolveProviderKey(accId, provider)
  if (!apiKey) return { ok: false, error: `Sin API key para ${provider}. Configúrala en la cuenta o en el Super Panel.` }

  // Conversaciones atendidas por la IA, con respuesta del negocio, aún sin evaluar.
  const [rows] = await pool.query(
    `SELECT c.id FROM conversations c
     WHERE c.account_id=? AND c.ai_enabled=1 AND c.qa_at IS NULL
       AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.sender='ai' AND m.content IS NOT NULL AND m.content<>"")
     ORDER BY c.updated_at DESC LIMIT ?`, [accId, limit])
  if (!rows.length) return { ok: true, evaluated: 0, remaining: 0 }

  let evaluated = 0
  for (const { id } of rows) {
    try {
      const [msgs] = await pool.query("SELECT sender, content FROM messages WHERE conversation_id=? AND content IS NOT NULL AND content<>'' ORDER BY ts ASC LIMIT 30", [id])
      let text = ''
      for (const m of msgs) { text += `${m.sender === 'user' ? 'Cliente' : 'Asistente'}: ${String(m.content).slice(0, 400)}\n`; if (text.length > 2800) break }
      if (!text.trim()) { await pool.query('UPDATE conversations SET qa_score=?, qa_flag=?, qa_at=? WHERE id=?', [null, '', Date.now(), id]); continue }
      const r = await callAI({ provider, model, apiKey, systemPrompt: SYS, userPrompt: text.trim(), maxTokens: 120, temperature: 0, jsonMode: provider !== 'anthropic' })
      const p = extractJson(r.text || '') || {}
      let score = Math.round(Number(p.puntaje)); if (!Number.isFinite(score)) score = null; else score = Math.max(0, Math.min(100, score))
      const flag = String(p.problema || '').slice(0, 160)
      await pool.query('UPDATE conversations SET qa_score=?, qa_flag=?, qa_at=? WHERE id=?', [score, flag, Date.now(), id])
      evaluated++
    } catch (e) { /* se reintenta en el próximo lote */ }
  }
  const [[rem]] = await pool.query('SELECT COUNT(*) AS n FROM conversations WHERE account_id=? AND ai_enabled=1 AND qa_at IS NULL', [accId])
  return { ok: true, evaluated, remaining: Number(rem?.n || 0), model }
}

module.exports = { qaBatch }
