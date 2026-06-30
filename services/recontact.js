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

// La config es una SECUENCIA de pasos: cada paso tiene su tiempo de espera (desde
// la última actividad) y su tipo (IA o flujo). `repeat` = al terminar la secuencia
// vuelve a empezar; `maxPerConversation` = tope total de recontactos por conversación.
// Por defecto el recontacto dispara el Flujo de entrada principal del agente
// (flowId null = usar el flujo de entrada principal); el texto libre de IA no se
// puede entregar en WhatsApp fuera de la ventana de 24 h, así que un flujo (que
// puede usar plantilla) es el mecanismo fiable para re-enganchar.
const DEFAULT_STEP = { delayMinutes: 1440, mode: 'flow', flowId: null, instructions: '', rounds: { mode: 'every' } }

// `rounds`: en qué VUELTAS (repeticiones de la secuencia) se ejecuta el paso.
//   every       → en todas las vueltas
//   only  + n   → solo en la vuelta n (1 = primera)
//   from  + n   → desde la vuelta n en adelante
//   list  + [n] → solo en las vueltas indicadas (p. ej. [1,3,5])
function normalizeRounds(r) {
  if (r?.mode === 'list') {
    const list = Array.from(new Set((Array.isArray(r.list) ? r.list : []).map(x => Math.max(1, Math.round(Number(x) || 0))).filter(n => n >= 1))).sort((a, b) => a - b).slice(0, 30)
    return list.length ? { mode: 'list', list } : { mode: 'every' }
  }
  const mode = (r?.mode === 'only' || r?.mode === 'from') ? r.mode : 'every'
  if (mode === 'every') return { mode: 'every' }
  return { mode, n: Math.max(1, Math.round(Number(r?.n) || 1)) }
}
function normalizeStep(s) {
  return {
    delayMinutes: Math.max(5, Math.round(Number(s?.delayMinutes) || 1440)),
    mode: s?.mode === 'intelligent' ? 'intelligent' : 'flow',  // por defecto: flujo
    flowId: s?.flowId || null,  // null en modo flujo = Flujo de entrada principal
    instructions: String(s?.instructions || '').slice(0, 600),  // IA: instrucciones extra · flujo: nota opcional
    rounds: normalizeRounds(s?.rounds),
  }
}

// ¿El paso aplica en esta vuelta (round 0-index)?
function stepAppliesToRound(step, round0) {
  const ur = round0 + 1
  const r = step.rounds || { mode: 'every' }
  if (r.mode === 'only') return ur === r.n
  if (r.mode === 'from') return ur >= r.n
  if (r.mode === 'list') return Array.isArray(r.list) && r.list.includes(ur)
  return true
}

// Devuelve la k-ésima ocurrencia (0-index) de la secuencia teniendo en cuenta las
// vueltas en que aplica cada paso, o null si la secuencia ya no produce más.
function nthOccurrence(steps, repeat, k) {
  const hasOpenEnded = steps.some(s => { const m = s.rounds?.mode; return !m || m === 'every' || m === 'from' })
  const boundedMax = Math.max(1, 0,
    ...steps.filter(s => s.rounds?.mode === 'only').map(s => s.rounds.n),
    ...steps.filter(s => s.rounds?.mode === 'list').flatMap(s => s.rounds.list || []))
  const roundLimit = repeat ? (hasOpenEnded ? 2000 : boundedMax) : 1
  let idx = 0
  for (let round = 0; round < roundLimit; round++) {
    for (let s = 0; s < steps.length; s++) {
      if (stepAppliesToRound(steps[s], round)) {
        if (idx === k) return { step: steps[s], round, stepIndex: s }
        idx++
      }
    }
  }
  return null
}
function normalize(c) {
  if (Array.isArray(c?.steps)) {
    const steps = c.steps.map(normalizeStep).slice(0, 10)
    return {
      enabled: !!c.enabled,
      steps: steps.length ? steps : [{ ...DEFAULT_STEP }],
      repeat: !!c.repeat,
      maxPerConversation: Math.max(1, Math.min(50, Math.round(Number(c.maxPerConversation) || steps.length || 1))),
    }
  }
  // Compatibilidad con el formato antiguo (un solo recontacto).
  if (c && (c.delayMinutes || c.mode)) {
    return { enabled: !!c.enabled, steps: [normalizeStep({ delayMinutes: c.delayMinutes, mode: c.mode, flowId: c.flowId })], repeat: false, maxPerConversation: Math.max(1, Math.round(Number(c.maxRecontacts) || 1)) }
  }
  return { enabled: false, steps: [{ ...DEFAULT_STEP }], repeat: false, maxPerConversation: 3 }
}

async function getConfig(accId) {
  const [[a]] = await pool.query('SELECT recontact FROM accounts WHERE id=?', [accId])
  return normalize(parseJ(a?.recontact, null))
}
async function saveConfig(accId, cfg) {
  const clean = normalize(cfg)
  await pool.query('UPDATE accounts SET recontact=? WHERE id=?', [JSON.stringify(clean), accId])
  return clean
}
function publicConfig(raw) {
  const c = normalize(parseJ(raw, null))
  return { enabled: c.enabled, steps: c.steps.length, repeat: c.repeat, maxPerConversation: c.maxPerConversation }
}

// Genera, con IA, un mensaje de recontacto analizando dónde quedó la conversación.
async function generateRecontactMessage(accId, agId, convId, account, extraInstructions) {
  const agent = account.agents?.find(a => a.id === agId)
  const active = agent?.prompts?.find(p => p.isActive) || agent?.prompts?.[0]
  const model = active?.model || 'gpt-4o-mini'
  const provider = detectProvider(model)
  const { key } = await resolveProviderKey(accId, provider)
  if (!key) return null
  const [rows] = await pool.query('SELECT sender, content FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 8', [convId])
  const history = rows.reverse().map(m => `${m.sender === 'user' ? 'Cliente' : 'Agente'}: ${(m.content || '').slice(0, 300)}`).join('\n')
  const extra = String(extraInstructions || '').trim()
  const sys = `Eres ${agent?.name || 'un asistente'} de atención al cliente. El cliente dejó de responder hace un rato. Redacta UN solo mensaje breve, cálido y natural para retomar la conversación EXACTAMENTE donde quedó (haz referencia a lo último que se habló) e invítalo a continuar. No te disculpes en exceso, no inventes datos ni precios. Máximo 2 frases. Responde SOLO con el mensaje, sin comillas.${extra ? `\n\nINSTRUCCIONES ADICIONALES (tienen prioridad): ${extra}` : ''}`
  try {
    const r = await callAI({ provider, model, apiKey: key, systemPrompt: sys, userPrompt: `Conversación hasta ahora:\n${history}\n\nMensaje de recontacto:`, maxTokens: 160, temperature: 0.6 })
    try { require('../controllers/analytics.controller').recordUsageInternal({ accId, agentId: agId, conversationId: convId, provider, model, promptTokens: r.usage?.promptTokens || 0, completionTokens: r.usage?.completionTokens || 0, source: 'recontact' }) } catch {}
    return (r.text || '').trim()
  } catch (e) { console.warn('[recontact LLM]', e.message); return null }
}

async function processConversation(accId, conv, step, account) {
  const agId = conv.agent_id
  const agent = account.agents?.find(a => a.id === agId)
  if (!agent) return
  const to = conv.wa_from || conv.messenger_from || conv.ig_from
  const outbound = buildOutbound(agent, conv.channel_type, conv.channel_id, to)
  if (!outbound) return  // canal no disponible para enviar

  if (step.mode === 'flow') {
    // flowId explícito o, por defecto, el Flujo de entrada principal del agente.
    const flowId = step.flowId || agent.fallbackFlowId || null
    if (!flowId) return  // no hay flujo de entrada principal configurado
    const nota = String(step.instructions || '').trim()
    await executeFlow({
      flowId, accId, agId, convId: conv.id,
      triggerContext: { recontact: true, motivo: 'recontacto_automatico', nota, message: nota, _lastUserMessage: '' },
      outbound,
    })
  } else {
    const text = await generateRecontactMessage(accId, agId, conv.id, account, step.instructions)
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
      const cfg = normalize(parseJ(a.recontact, null))
      if (!cfg.enabled || !cfg.steps.length) continue
      const minDelay = Math.min(...cfg.steps.map(s => s.delayMinutes))
      const cutoff = now - minDelay * 60000
      // Prefiltro: inactivas más que el paso más corto, y que aún no llegaron al tope
      // O donde el cliente respondió tras el último recontacto (recontact_at < updated_at → reinicio).
      const [convos] = await pool.query(
        `SELECT id, agent_id, channel_type, channel_id, wa_from, messenger_from, ig_from, updated_at, recontact_at, recontact_count FROM conversations
         WHERE account_id=? AND ai_enabled=1 AND channel_type IN ('whatsapp','messenger','instagram')
           AND updated_at <= ? AND (recontact_count < ? OR recontact_at IS NULL OR recontact_at < updated_at)
         ORDER BY updated_at ASC LIMIT ?`,
        [a.id, cutoff, cfg.maxPerConversation, SCAN_LIMIT]
      )
      if (!convos.length) continue
      const account = await store.loadAccount(a.id)
      if (!account) continue
      for (const conv of convos) {
        // Solo si el cliente fue quien dejó de responder (último mensaje del agente/IA).
        const [[last]] = await pool.query('SELECT sender FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 1', [conv.id])
        if (!last || last.sender === 'user') continue

        let count = conv.recontact_count || 0
        // Reinicio de la secuencia si el cliente respondió DESPUÉS del último recontacto.
        if (count > 0 && conv.recontact_at) {
          const [[lu]] = await pool.query("SELECT ts FROM messages WHERE conversation_id=? AND sender='user' ORDER BY ts DESC LIMIT 1", [conv.id])
          if (lu && lu.ts > conv.recontact_at) { count = 0; await pool.query('UPDATE conversations SET recontact_count=0, recontact_at=NULL WHERE id=?', [conv.id]) }
        }
        if (count >= cfg.maxPerConversation) continue
        // Paso actual según las vueltas en que aplica cada paso (repite o termina).
        const occ = nthOccurrence(cfg.steps, cfg.repeat, count)
        if (!occ) continue   // secuencia terminada (no hay más ocurrencias)
        const step = occ.step
        if ((conv.updated_at || 0) > now - step.delayMinutes * 60000) continue  // aún no toca este paso

        try { await processConversation(a.id, conv, step, account) } catch (e) { console.warn('[recontact conv]', e.message) }
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
