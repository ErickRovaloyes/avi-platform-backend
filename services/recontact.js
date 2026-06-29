'use strict'
/**
 * Recontactos inteligentes — re-engancha conversaciones abandonadas por el cliente.
 * Config por cuenta (accounts.recontact): tiempo de inactividad, modo (inteligente
 * o flujo) y tope. Un worker escanea periódicamente las conversaciones donde el
 * cliente dejó de responder y, según el modo:
 *   - inteligente: la IA redacta un mensaje retomando dónde quedó la conversación,
 *   - flujo: dispara el flujo configurado.
 */
const pool = require('../db')
const { parseJ } = require('../utils')
const store = require('../flow/store')
const { sendBotMsg } = require('../flow/common')
const { buildOutbound } = require('./calendarNotify')
const { executeFlow } = require('../flow/engine')
const { callAI, detectProvider, resolveProviderKey } = require('../controllers/promptGenerator.controller')

const SCAN_LIMIT = 50

const DEFAULTS = { enabled: false, delayMinutes: 1440, mode: 'intelligent', flowId: null, maxRecontacts: 1 }

async function getConfig(accId) {
  const [[a]] = await pool.query('SELECT recontact FROM accounts WHERE id=?', [accId])
  return { ...DEFAULTS, ...(parseJ(a?.recontact, null) || {}) }
}
async function saveConfig(accId, cfg) {
  const clean = {
    enabled: !!cfg.enabled,
    delayMinutes: Math.max(5, Number(cfg.delayMinutes) || 1440),
    mode: cfg.mode === 'flow' ? 'flow' : 'intelligent',
    flowId: cfg.flowId || null,
    maxRecontacts: Math.max(1, Math.min(5, Number(cfg.maxRecontacts) || 1)),
  }
  await pool.query('UPDATE accounts SET recontact=? WHERE id=?', [JSON.stringify(clean), accId])
  return clean
}
function publicConfig(raw) {
  const c = parseJ(raw, null)
  return c ? { enabled: !!c.enabled, mode: c.mode, delayMinutes: c.delayMinutes, maxRecontacts: c.maxRecontacts } : { enabled: false }
}

// Genera, con IA, un mensaje de recontacto analizando dónde quedó la conversación.
async function generateRecontactMessage(accId, agId, convId, account) {
  const agent = account.agents?.find(a => a.id === agId)
  const active = agent?.prompts?.find(p => p.isActive) || agent?.prompts?.[0]
  const model = active?.model || 'gpt-4o-mini'
  const provider = detectProvider(model)
  const { key } = await resolveProviderKey(accId, provider)
  if (!key) return null
  const [rows] = await pool.query('SELECT sender, content FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 8', [convId])
  const history = rows.reverse().map(m => `${m.sender === 'user' ? 'Cliente' : 'Agente'}: ${(m.content || '').slice(0, 300)}`).join('\n')
  const sys = `Eres ${agent?.name || 'un asistente'} de atención al cliente. El cliente dejó de responder hace un rato. Redacta UN solo mensaje breve, cálido y natural para retomar la conversación EXACTAMENTE donde quedó (haz referencia a lo último que se habló) e invítalo a continuar. No te disculpes en exceso, no inventes datos ni precios. Máximo 2 frases. Responde SOLO con el mensaje, sin comillas.`
  try {
    const r = await callAI({ provider, model, apiKey: key, systemPrompt: sys, userPrompt: `Conversación hasta ahora:\n${history}\n\nMensaje de recontacto:`, maxTokens: 160, temperature: 0.6 })
    try { require('../controllers/analytics.controller').recordUsageInternal({ accId, agentId: agId, conversationId: convId, provider, model, promptTokens: r.usage?.promptTokens || 0, completionTokens: r.usage?.completionTokens || 0, source: 'recontact' }) } catch {}
    return (r.text || '').trim()
  } catch (e) { console.warn('[recontact LLM]', e.message); return null }
}

async function processConversation(accId, conv, cfg, account) {
  const agId = conv.agent_id
  const agent = account.agents?.find(a => a.id === agId)
  if (!agent) return
  const to = conv.wa_from || conv.messenger_from || conv.ig_from
  const outbound = buildOutbound(agent, conv.channel_type, conv.channel_id, to)
  if (!outbound) return  // canal no disponible para enviar

  if (cfg.mode === 'flow' && cfg.flowId) {
    await executeFlow({ flowId: cfg.flowId, accId, agId, convId: conv.id, triggerContext: { recontact: true, motivo: 'recontacto_automatico' }, outbound })
  } else {
    const text = await generateRecontactMessage(accId, agId, conv.id, account)
    if (!text) return
    await sendBotMsg({ accId, agId, convId: conv.id, _outbound: outbound }, text, { recontact: true })
  }
  await pool.query('UPDATE conversations SET recontact_at=?, recontact_count=recontact_count+1 WHERE id=?', [Date.now(), conv.id])
}

async function tick() {
  try {
    const [accs] = await pool.query('SELECT id, recontact FROM accounts WHERE recontact IS NOT NULL')
    const now = Date.now()
    for (const a of accs) {
      const cfg = parseJ(a.recontact, null)
      if (!cfg?.enabled) continue
      const cutoff = now - (cfg.delayMinutes || 1440) * 60000
      const max = cfg.maxRecontacts || 1
      const [convos] = await pool.query(
        `SELECT id, agent_id, channel_type, channel_id, wa_from, messenger_from, ig_from FROM conversations
         WHERE account_id=? AND ai_enabled=1 AND channel_type IN ('whatsapp','messenger','instagram')
           AND updated_at <= ? AND recontact_count < ? AND (recontact_at IS NULL OR recontact_at < updated_at)
         ORDER BY updated_at ASC LIMIT ?`,
        [a.id, cutoff, max, SCAN_LIMIT]
      )
      if (!convos.length) continue
      const account = await store.loadAccount(a.id)
      if (!account) continue
      for (const conv of convos) {
        // Solo si el cliente fue quien dejó de responder (el último mensaje es del agente/IA).
        const [[last]] = await pool.query('SELECT sender FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 1', [conv.id])
        if (!last || last.sender === 'user') continue
        try { await processConversation(a.id, conv, cfg, account) } catch (e) { console.warn('[recontact conv]', e.message) }
      }
    }
  } catch (e) { console.warn('[recontact tick]', e.message) }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(() => tick().catch(() => {}), 10 * 60 * 1000) // cada 10 min
  _timer.unref?.()
  setTimeout(() => tick().catch(() => {}), 30000) // primer pase a los 30s
}

module.exports = { getConfig, saveConfig, publicConfig, tick, startWorker }
