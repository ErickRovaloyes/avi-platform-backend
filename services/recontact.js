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
    delayMinutes: Math.max(1, Math.round(Number(s?.delayMinutes) || 1440)),
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

// ── Diagnóstico: ¿por qué (no) se recontacta? Dry-run, no envía nada. ─────────
async function diagnose(accId) {
  const cfg = await getConfig(accId)
  const now = Date.now()
  const out = { enabled: cfg.enabled, steps: cfg.steps.length, repeat: cfg.repeat, maxPerConversation: cfg.maxPerConversation, candidates: [] }
  if (!cfg.enabled) { out.note = 'Los recontactos están DESACTIVADOS. Actívalos para que el worker los procese.'; return out }
  const minDelay = Math.min(...cfg.steps.map(s => s.delayMinutes))
  const cutoff = now - minDelay * 60000
  out.minDelayMin = minDelay
  // Conversaciones de los canales soportados, recientes, para explicar su estado.
  const [convos] = await pool.query(
    "SELECT id, agent_id, channel_type, channel_id, wa_from, messenger_from, ig_from, guest_name, ai_enabled, updated_at, recontact_at, recontact_count FROM conversations WHERE account_id=? AND channel_type IN ('whatsapp','messenger','instagram') ORDER BY updated_at DESC LIMIT 15",
    [accId]
  )
  if (!convos.length) { out.note = 'No hay conversaciones de WhatsApp/Messenger/Instagram en esta cuenta.'; return out }
  const account = await store.loadAccount(accId)
  for (const conv of convos) {
    const label = `${conv.guest_name || conv.id} · ${conv.channel_type}`
    const reasons = []
    if (!conv.ai_enabled) reasons.push('IA del chat APAGADA (ai_enabled=0)')
    const [[last]] = await pool.query('SELECT sender FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 1', [conv.id])
    if (!last) reasons.push('sin mensajes')
    else if (last.sender === 'user') reasons.push('el ÚLTIMO mensaje es del cliente (solo se recontacta cuando el último fue del agente/IA)')
    if ((conv.updated_at || 0) > cutoff) reasons.push(`aún no cumple la espera mínima (${minDelay} min desde la última actividad)`)
    const count = conv.recontact_count || 0
    if (count >= cfg.maxPerConversation && conv.recontact_at && conv.recontact_at >= (conv.updated_at || 0)) reasons.push(`alcanzó el máximo de recontactos (${cfg.maxPerConversation})`)
    const agent = account?.agents?.find(a => a.id === conv.agent_id)
    if (!agent) reasons.push('agente no encontrado')
    else {
      const to = conv.wa_from || conv.messenger_from || conv.ig_from
      if (!buildOutbound(agent, conv.channel_type, conv.channel_id, to)) reasons.push(`canal "${conv.channel_type}" no enviable (faltan credenciales del canal o identificador del cliente)`)
      const step0 = cfg.steps[0]
      if (step0?.mode === 'flow' && !step0.flowId && !agent.fallbackFlowId) reasons.push('paso por defecto = Flujo de entrada principal, pero el agente NO tiene flujo de entrada configurado')
    }
    out.candidates.push({ conv: label, recontactCount: count, eligible: reasons.length === 0, reasons })
  }
  return out
}

// ── Prueba manual: fuerza un recontacto AHORA en una conversación (ignora la
//    espera y la regla de "último mensaje del agente"), y reporta qué pasó. ────
async function testNow(accId, convId) {
  const cfg = await getConfig(accId)
  const account = await store.loadAccount(accId)
  if (!account) return { ok: false, reason: 'No se pudo cargar la cuenta.' }
  let conv
  if (convId) {
    const [[c]] = await pool.query('SELECT id, agent_id, channel_type, channel_id, wa_from, messenger_from, ig_from, guest_name FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    conv = c
  } else {
    const [[c]] = await pool.query("SELECT id, agent_id, channel_type, channel_id, wa_from, messenger_from, ig_from, guest_name FROM conversations WHERE account_id=? AND channel_type IN ('whatsapp','messenger','instagram') ORDER BY updated_at DESC LIMIT 1", [accId])
    conv = c
  }
  if (!conv) return { ok: false, reason: 'No hay conversaciones de WhatsApp/Messenger/Instagram para probar.' }
  const label = `${conv.guest_name || conv.id} · ${conv.channel_type}`
  const agent = account.agents?.find(a => a.id === conv.agent_id)
  if (!agent) return { ok: false, conv: label, reason: 'No se encontró el agente de la conversación.' }
  const to = conv.wa_from || conv.messenger_from || conv.ig_from
  const outbound = buildOutbound(agent, conv.channel_type, conv.channel_id, to)
  if (!outbound) return { ok: false, conv: label, reason: `Canal "${conv.channel_type}" no enviable: el agente no tiene ese canal conectado con credenciales (token/ID) o falta el identificador del cliente (${to || 'vacío'}).` }
  const step = cfg.steps[0] || { mode: 'flow', flowId: null, instructions: '' }

  if (step.mode === 'flow') {
    const flowId = step.flowId || agent.fallbackFlowId || null
    if (!flowId) return { ok: false, conv: label, mode: 'flow', reason: 'El paso usa "Flujo de entrada principal" pero el agente no tiene un flujo de entrada configurado, ni elegiste un flujo específico. Configura el flujo de entrada del agente o elige un flujo en el paso.' }
    const nota = String(step.instructions || '').trim()
    try {
      await executeFlow({ flowId, accId, agId: conv.agent_id, convId: conv.id, triggerContext: { recontact: true, motivo: 'prueba_recontacto', nota, message: nota, _lastUserMessage: '' }, outbound })
      return { ok: true, conv: label, mode: 'flow', flowId, note: `Flujo ejecutado en "${label}". Revisa el chat. ⚠ En WhatsApp, si pasaron 24 h sin respuesta del cliente, el mensaje solo se ENTREGA si el flujo envía una PLANTILLA aprobada (el texto libre lo bloquea Meta).` }
    } catch (e) {
      return { ok: false, conv: label, mode: 'flow', flowId, reason: `El flujo falló al ejecutarse: ${e.message}` }
    }
  }
  // Modo IA
  const text = await generateRecontactMessage(accId, conv.agent_id, conv.id, account, step.instructions)
  if (!text) return { ok: false, conv: label, mode: 'ia', reason: 'La IA no generó texto. Suele faltar la API key del proveedor del modelo del prompt activo (configúrala en la cuenta o en el Super Panel).' }
  const res = await sendBotMsg({ accId, agId: conv.agent_id, convId: conv.id, _outbound: outbound }, text, { recontact: true })
  if (res?.status === 'failed') return { ok: false, conv: label, mode: 'ia', text, reason: `El canal rechazó el envío: ${res.sendError}. ⚠ En WhatsApp, fuera de la ventana de 24 h solo se permiten PLANTILLAS, no texto libre — usa el modo "flujo" con una plantilla.` }
  return { ok: true, conv: label, mode: 'ia', text, note: `Mensaje enviado a "${label}".` }
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
  // Cada minuto: el mínimo de espera de un paso es 1 min, así que el escaneo debe
  // ser igual de fino para no retrasar los recontactos cortos. El prefiltro es
  // selectivo (solo cuentas con recontact y convos ya vencidas), así que es barato.
  _timer = setInterval(() => tick().catch(() => {}), 60 * 1000)
  _timer.unref?.()
  setTimeout(() => tick().catch(() => {}), 30000) // primer pase a los 30s
}

module.exports = { getConfig, saveConfig, publicConfig, tick, startWorker, diagnose, testNow }
