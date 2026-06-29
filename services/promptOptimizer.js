'use strict'
/**
 * Optimizador Inteligente del Prompt — Fase 1: indexado estructurado INCREMENTAL
 * de las conversaciones (sin IA). Para cada conversación nueva o modificada desde
 * el último análisis, deriva por CÓDIGO una ficha (tema, resuelto, confianza, uso
 * de RAG, herramientas, errores, reformulaciones, escalación a humano, abandono,
 * motivo de fallo) y la guarda en optimizer_convo_index. Las fases 2–4 (selección,
 * clustering, IA, sugerencias, dashboard) se construyen encima de este índice.
 */
const crypto = require('crypto')
const pool = require('../db')
const { uid, parseJ } = require('../utils')
// Helpers IA reutilizables (mismo patrón que el generador de prompts).
const { callAI, detectProvider, resolveProviderKey, extractJson } = require('../controllers/promptGenerator.controller')

const RUN_CAP = 3000  // máx. conversaciones procesadas por ejecución (acota cada run)
const SAMPLE_PER_GROUP = 5 // ejemplos representativos por grupo enviados al LLM

function hashContent(s) { return 'v' + crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 8) }

async function activePromptVersion(accId, agId) {
  try {
    const [[ag]] = await pool.query('SELECT prompts FROM agents WHERE id=? AND account_id=?', [agId, accId])
    const prompts = parseJ(ag?.prompts, [])
    const active = prompts.find(p => p.isActive) || prompts[0]
    return active ? hashContent(active.content) : 'v0'
  } catch { return 'v0' }
}

// ── Detección de tema por palabras clave (rápida; el clustering fino es Fase 3) ──
const TOPIC_RULES = [
  ['pagos', /\b(pago|pagar|tarjeta|transferenc|factur|cobr|precio|cuesta|vale|coste)\b/i],
  ['envios', /\b(env[ií]o|enviar|domicilio|entrega|despacho|rastreo|gu[ií]a|paqueter)\b/i],
  ['garantia', /\b(garant[ií]a|devoluci|reembolso|cambio de producto|defectuoso|da[ñn]ado)\b/i],
  ['horarios', /\b(horario|abren|cierran|atienden|disponib|agenda|cita|reserva)\b/i],
  ['soporte', /\b(no funciona|error|problema|falla|ayuda|soporte|reclamo|queja)\b/i],
  ['producto', /\b(producto|art[ií]culo|modelo|talla|color|stock|cat[aá]logo|caracter[ií]stic)\b/i],
]
function detectTopic(userText) {
  for (const [topic, re] of TOPIC_RULES) if (re.test(userText)) return topic
  return 'general'
}

const HUMAN_RE = /\b(asesor|humano|una persona|persona real|agente real|hablar con alguien|representante|operador|atienda alguien)\b/i

// Deriva la ficha estructurada de una conversación a partir de sus mensajes.
function analyzeConversation(conv, messages, promptVersion) {
  const ordered = [...messages].sort((a, b) => (a.ts || 0) - (b.ts || 0))
  const msgCount = ordered.length
  const firstTs = ordered[0]?.ts || conv.created_at || 0
  const lastTs = ordered[ordered.length - 1]?.ts || conv.updated_at || 0
  const last = ordered[ordered.length - 1]
  const userText = ordered.filter(m => m.sender === 'user').map(m => m.content || '').join(' \n ')
  const hadHuman = ordered.some(m => m.sender === 'human')
  const askedHuman = hadHuman || HUMAN_RE.test(userText)

  // Reformulaciones: el usuario vuelve a escribir sin recibir respuesta entre medias.
  let reformulations = 0
  for (let i = 1; i < ordered.length; i++) if (ordered[i].sender === 'user' && ordered[i - 1].sender === 'user') reformulations++

  // Errores / herramientas / RAG: del debug_log + metadata de los mensajes.
  const dbg = parseJ(conv.debug_log, [])
  const errors = []
  const toolsSet = new Set()
  let usedRag = false, ragHit = false
  for (const e of (Array.isArray(dbg) ? dbg : [])) {
    if (!e) continue
    if (e.type === 'error' || e.level === 'error') errors.push(String(e.message || e.msg || 'error').slice(0, 120))
    if (e.type === 'tool_result' || e.type === 'tool_call' || e.type === 'tool') { const n = e.tool || e.name; if (n) toolsSet.add(String(n)) }
    const blob = (typeof e === 'string' ? e : JSON.stringify(e)).toLowerCase()
    if (blob.includes('rag') || blob.includes('contexto de conocimiento') || blob.includes('conocimiento')) {
      usedRag = true
      if (blob.includes('fragmento') || blob.includes('relevant')) ragHit = true
    }
  }
  for (const m of ordered) {
    const md = parseJ(m.metadata, null)
    if (md?.tool) toolsSet.add(String(md.tool))
    if (Array.isArray(md?.toolCalls)) md.toolCalls.forEach(t => toolsSet.add(String(t?.name || t)))
  }
  const toolsUsed = [...toolsSet]

  const unanswered = last?.sender === 'user'                 // el cliente escribió y no se respondió
  const abandoned = !unanswered && !askedHuman && msgCount >= 2 && userText.length < 40 && ordered.filter(m => m.sender === 'user').length <= 1
  const topic = detectTopic(userText)
  const resolved = !unanswered && !askedHuman && errors.length === 0 && reformulations < 2

  let confidence = 0.75
  if (errors.length) confidence -= 0.25
  if (askedHuman) confidence -= 0.2
  if (reformulations >= 2) confidence -= 0.2
  if (unanswered) confidence -= 0.15
  if (usedRag && !ragHit) confidence -= 0.1
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))))

  let failReason = null
  if (errors.length) failReason = 'tool_error'
  else if (askedHuman) failReason = 'escalation'
  else if (reformulations >= 2) failReason = 'misunderstanding'
  else if (usedRag && !ragHit) failReason = 'rag_no_result'
  else if (unanswered) failReason = 'unanswered'
  else if (abandoned) failReason = 'abandoned'

  return {
    msgCount, lastMsgTs: lastTs, durationMs: Math.max(0, lastTs - firstTs), topic,
    resolved: resolved ? 1 : 0, confidence, usedRag: usedRag ? 1 : 0, ragHit: ragHit ? 1 : 0,
    toolsUsed, errors, reformulations, askedHuman: askedHuman ? 1 : 0, abandoned: abandoned ? 1 : 0,
    failReason, promptVersion,
  }
}

// Cursor = updated_at máximo ya procesado (del último run terminado).
async function lastCursor(accId, agId) {
  const [[r]] = await pool.query(
    "SELECT last_cursor_ts FROM optimizer_runs WHERE account_id=? AND agent_id=? AND status='done' ORDER BY started_at DESC LIMIT 1",
    [accId, agId]
  )
  return r?.last_cursor_ts || 0
}

async function pendingCount(accId, agId, cursor) {
  const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM conversations WHERE account_id=? AND agent_id=? AND updated_at > ?', [accId, agId, cursor])
  return r?.n || 0
}

// ── Estado para la pantalla principal ──────────────────────────────────────────
async function getStatus(accId, agId) {
  const cursor = await lastCursor(accId, agId)
  const [[lastRun]] = await pool.query('SELECT * FROM optimizer_runs WHERE account_id=? AND agent_id=? ORDER BY started_at DESC LIMIT 1', [accId, agId])
  const [[running]] = await pool.query("SELECT id FROM optimizer_runs WHERE account_id=? AND agent_id=? AND status='running' ORDER BY started_at DESC LIMIT 1", [accId, agId])
  const [[idx]] = await pool.query('SELECT COUNT(*) AS n FROM optimizer_convo_index WHERE account_id=? AND agent_id=?', [accId, agId])
  const pending = await pendingCount(accId, agId, cursor)
  const [sugRows] = await pool.query('SELECT status, COUNT(*) AS n FROM optimizer_suggestions WHERE account_id=? AND agent_id=? GROUP BY status', [accId, agId])
  const sug = {}; for (const r of sugRows) sug[r.status] = r.n
  const promptVersion = await activePromptVersion(accId, agId)
  return {
    promptVersion,
    running: !!running,
    lastRun: lastRun ? {
      at: lastRun.finished_at || lastRun.started_at, startedBy: lastRun.started_by,
      promptVersion: lastRun.prompt_version, convosProcessed: lastRun.convos_processed,
      status: lastRun.status, suggestionsNew: lastRun.suggestions_new,
    } : null,
    totalIndexed: idx?.n || 0,
    pending,                                   // nuevas + modificadas sin analizar
    suggestions: {
      active: (sug.new || 0) + (sug.active || 0) + (sug.in_review || 0),
      applied: sug.applied || 0,
      resolved: sug.resolved || 0,
      discarded: sug.discarded || 0,
    },
  }
}

// ── Ejecuta una pasada incremental (Fase 1: solo etapa 1, sin IA) ──────────────
async function run(accId, agId, startedBy) {
  const runId = 'orun_' + uid()
  const now = Date.now()
  const promptVersion = await activePromptVersion(accId, agId)
  const cursor = await lastCursor(accId, agId)
  await pool.query(
    'INSERT INTO optimizer_runs (id,account_id,agent_id,started_by,prompt_version,last_cursor_ts,status,started_at) VALUES (?,?,?,?,?,?,?,?)',
    [runId, accId, agId, String(startedBy || '').slice(0, 100), promptVersion, cursor, 'running', now]
  )
  // Procesa en background; el endpoint ya devolvió el runId.
  ;(async () => {
    let processed = 0, maxCursor = cursor
    const candidates = []   // convos con motivo de fallo → entran al análisis IA
    try {
      const [convos] = await pool.query(
        'SELECT id, created_at, updated_at, debug_log FROM conversations WHERE account_id=? AND agent_id=? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?',
        [accId, agId, cursor, RUN_CAP]
      )
      for (const conv of convos) {
        const [msgs] = await pool.query('SELECT sender, content, metadata, ts FROM messages WHERE conversation_id=? ORDER BY ts ASC', [conv.id])
        const f = analyzeConversation(conv, msgs, promptVersion)
        await pool.query(
          `INSERT INTO optimizer_convo_index
            (conversation_id,account_id,agent_id,prompt_version,msg_count,last_msg_ts,seen_updated_at,duration_ms,topic,resolved,confidence,used_rag,rag_hit,tools_used,errors,reformulations,asked_human,abandoned,fail_reason,analyzed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE prompt_version=VALUES(prompt_version),msg_count=VALUES(msg_count),last_msg_ts=VALUES(last_msg_ts),seen_updated_at=VALUES(seen_updated_at),duration_ms=VALUES(duration_ms),topic=VALUES(topic),resolved=VALUES(resolved),confidence=VALUES(confidence),used_rag=VALUES(used_rag),rag_hit=VALUES(rag_hit),tools_used=VALUES(tools_used),errors=VALUES(errors),reformulations=VALUES(reformulations),asked_human=VALUES(asked_human),abandoned=VALUES(abandoned),fail_reason=VALUES(fail_reason),analyzed_at=VALUES(analyzed_at)`,
          [conv.id, accId, agId, f.promptVersion, f.msgCount, f.lastMsgTs, conv.updated_at || 0, f.durationMs, f.topic, f.resolved, f.confidence, f.usedRag, f.ragHit, JSON.stringify(f.toolsUsed), JSON.stringify(f.errors), f.reformulations, f.askedHuman, f.abandoned, f.failReason, Date.now()]
        )
        processed++
        if (f.failReason) candidates.push({ convId: conv.id, ficha: f })
        if ((conv.updated_at || 0) > maxCursor) maxCursor = conv.updated_at
      }
      // Etapas 2-5: análisis con IA (solo si hay candidatas y modelo/clave disponibles).
      let res = { newCount: 0, updatedCount: 0, tokens: 0, cost: 0 }
      if (candidates.length) res = await analyzeCandidates(accId, agId, candidates)
      await pool.query('UPDATE optimizer_runs SET convos_processed=?, last_cursor_ts=?, suggestions_new=?, suggestions_updated=?, tokens_used=?, status=?, finished_at=? WHERE id=?',
        [processed, maxCursor, res.newCount, res.updatedCount, res.tokens, 'done', Date.now(), runId])
    } catch (err) {
      console.error('[optimizer run]', err.message)
      await pool.query('UPDATE optimizer_runs SET convos_processed=?, status=?, finished_at=? WHERE id=?', [processed, 'error', Date.now(), runId]).catch(() => {})
    }
  })()
  return { runId, promptVersion }
}

// ── Etapas 2-5: agrupación + muestreo + análisis IA + dedup de sugerencias ──────
const OPTIMIZER_SYS = `Eres un analista experto en prompt engineering para agentes de IA de atención al cliente.
Recibes un GRUPO de conversaciones donde el agente tuvo el MISMO tipo de problema. Detecta la causa raíz y propón UNA mejora concreta.
Determina si el problema pertenece al prompt, al RAG/base de conocimiento, a las herramientas, al flujo conversacional o a una limitación del modelo.
Responde ÚNICAMENTE con un objeto JSON válido (sin texto fuera de él):
{
 "title": "título corto del problema",
 "description": "1-3 frases explicando la causa raíz",
 "problem_type": "prompt|rag|knowledge|tools|flow|model",
 "severity": "baja|media|alta",
 "impact": "bajo|medio|alto",
 "proposed_change": { "section": "sección del prompt a tocar", "add": "texto a agregar (o \\"\\")", "remove": "texto a quitar (o \\"\\")", "replace": "texto a reemplazar (o \\"\\")", "justification": "por qué", "expected_impact": "mejora esperada" },
 "evidence": "1-2 frases con la evidencia observada"
}`

// Resumen COMPACTO de una conversación (no se envía completa): primer mensaje del
// cliente + última respuesta del agente. Minimiza tokens.
async function summarizeConvo(convId) {
  try {
    const [msgs] = await pool.query('SELECT sender, content FROM messages WHERE conversation_id=? ORDER BY ts ASC', [convId])
    const firstUser = (msgs.find(m => m.sender === 'user')?.content || '').slice(0, 200)
    const lastBot = ([...msgs].reverse().find(m => m.sender === 'ai' || m.sender === 'human')?.content || '').slice(0, 200)
    return `Cliente: "${firstUser}" → Agente: "${lastBot}"`
  } catch { return '' }
}

async function analyzeCandidates(accId, agId, candidates) {
  const [[ps]] = await pool.query('SELECT optimizer_model FROM platform_settings WHERE id=1')
  const model = ps?.optimizer_model || 'gpt-4o-mini'
  const provider = detectProvider(model)
  const { key: apiKey } = await resolveProviderKey(accId, provider)
  if (!apiKey) return { newCount: 0, updatedCount: 0, tokens: 0, cost: 0 } // sin clave → no se gasta IA

  // Etapa 3: agrupar por (tema, motivo de fallo) — determinista, sin tokens.
  const groups = new Map()
  for (const c of candidates) {
    const key = `${c.ficha.topic}|${c.ficha.failReason}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }

  let newCount = 0, updatedCount = 0, tokens = 0
  for (const [key, group] of groups) {
    const [topic, failReason] = key.split('|')
    const sample = group.slice(0, SAMPLE_PER_GROUP)           // Etapa 4: muestreo
    const summaries = []
    for (const c of sample) summaries.push(await summarizeConvo(c.convId))
    const avgConf = (group.reduce((s, c) => s + (c.ficha.confidence || 0), 0) / group.length).toFixed(2)
    const userMsg = `GRUPO: tema="${topic}", tipo_de_fallo="${failReason}", conversaciones=${group.length}, confianza_promedio=${avgConf}\n\nEJEMPLOS REPRESENTATIVOS:\n${summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    let parsed = null
    try {
      const r = await callAI({ provider, model, apiKey, systemPrompt: OPTIMIZER_SYS, userPrompt: userMsg, maxTokens: 800, temperature: 0.3, jsonMode: provider !== 'anthropic' })
      tokens += (r.usage?.promptTokens || 0) + (r.usage?.completionTokens || 0)
      try { require('../controllers/analytics.controller').recordUsageInternal({ accId, agentId: agId, conversationId: null, provider, model, promptTokens: r.usage?.promptTokens || 0, completionTokens: r.usage?.completionTokens || 0, source: 'optimizer' }) } catch {}
      parsed = extractJson(r.text || '')
    } catch (e) { console.warn('[optimizer LLM]', e.message); continue }
    if (!parsed?.title) continue
    const dedupeKey = `${String(parsed.problem_type || 'prompt')}:${topic}:${failReason}`.toLowerCase().slice(0, 120)
    const kind = await upsertSuggestion(accId, agId, { parsed, dedupeKey, groupSize: group.length, evidence: sample.map(c => c.convId) })
    if (kind === 'new') newCount++; else updatedCount++
  }
  return { newCount, updatedCount, tokens, cost: 0 }
}

async function upsertSuggestion(accId, agId, { parsed, dedupeKey, groupSize, evidence }) {
  const now = Date.now()
  const [[existing]] = await pool.query('SELECT id, conversations, status FROM optimizer_suggestions WHERE account_id=? AND agent_id=? AND dedupe_key=? LIMIT 1', [accId, agId, dedupeKey])
  if (existing) {
    const merged = Array.from(new Set([...parseJ(existing.conversations, []), ...evidence])).slice(0, 30)
    // Si estaba "resuelta" pero reaparece → vuelve a "activa". "Descartada" se respeta.
    const status = existing.status === 'resolved' ? 'active' : existing.status
    await pool.query(
      'UPDATE optimizer_suggestions SET frequency=frequency+?, conversations=?, description=?, severity=?, impact=?, proposed_change=?, status=?, updated_at=? WHERE id=?',
      [groupSize, JSON.stringify(merged), parsed.description || '', parsed.severity || 'media', parsed.impact || 'medio', JSON.stringify(parsed.proposed_change || null), status, now, existing.id]
    )
    return 'updated'
  }
  const [[cnt]] = await pool.query('SELECT COUNT(*) AS n FROM optimizer_suggestions WHERE account_id=? AND agent_id=?', [accId, agId])
  const code = 'SUG-' + String((cnt?.n || 0) + 1).padStart(3, '0')
  const id = 'sug_' + uid()
  await pool.query(
    `INSERT INTO optimizer_suggestions (id,code,account_id,agent_id,title,description,problem_type,severity,impact,frequency,conversations,evidence,proposed_change,status,dedupe_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, code, accId, agId, String(parsed.title || '').slice(0, 200), parsed.description || '', String(parsed.problem_type || 'prompt'), parsed.severity || 'media', parsed.impact || 'medio', groupSize, JSON.stringify(evidence), JSON.stringify(parsed.evidence || ''), JSON.stringify(parsed.proposed_change || null), 'new', dedupeKey, now, now]
  )
  return 'new'
}

const VALID_STATUS = new Set(['new', 'active', 'in_review', 'applied', 'discarded', 'resolved'])
async function setSuggestionStatus(accId, agId, sid, status, appliedVersion) {
  if (!VALID_STATUS.has(status)) throw new Error('Estado no válido')
  const sets = ['status=?', 'updated_at=?']; const vals = [status, Date.now()]
  if (appliedVersion !== undefined) { sets.push('applied_version=?'); vals.push(appliedVersion) }
  vals.push(sid, accId, agId)
  await pool.query(`UPDATE optimizer_suggestions SET ${sets.join(',')} WHERE id=? AND account_id=? AND agent_id=?`, vals)
  return { ok: true }
}

async function getSuggestions(accId, agId) {
  const [rows] = await pool.query('SELECT * FROM optimizer_suggestions WHERE account_id=? AND agent_id=? ORDER BY frequency DESC, updated_at DESC', [accId, agId])
  return rows.map(r => ({
    id: r.id, code: r.code || r.id, title: r.title, description: r.description, problemType: r.problem_type,
    severity: r.severity, impact: r.impact, frequency: r.frequency,
    conversations: parseJ(r.conversations, []), evidence: parseJ(r.evidence, ''),
    proposedChange: parseJ(r.proposed_change, null), status: r.status,
    appliedVersion: r.applied_version, createdAt: r.created_at, updatedAt: r.updated_at,
  }))
}

// ── Dashboard de indicadores (Fase 4) ──────────────────────────────────────────
async function getDashboard(accId, agId) {
  const where = 'account_id=? AND agent_id=?'; const p = [accId, agId]
  const [[tot]] = await pool.query(`SELECT COUNT(*) AS total, SUM(resolved) AS resolved, AVG(confidence) AS avgConf, SUM(abandoned) AS abandoned, SUM(CASE WHEN fail_reason IS NOT NULL THEN 1 ELSE 0 END) AS failed FROM optimizer_convo_index WHERE ${where}`, p)
  const [byTopic] = await pool.query(`SELECT topic, COUNT(*) AS total, SUM(resolved) AS resolved, SUM(abandoned) AS abandoned, SUM(CASE WHEN fail_reason IS NOT NULL THEN 1 ELSE 0 END) AS failed FROM optimizer_convo_index WHERE ${where} GROUP BY topic ORDER BY failed DESC, total DESC LIMIT 12`, p)
  const [byFail] = await pool.query(`SELECT fail_reason AS reason, COUNT(*) AS n FROM optimizer_convo_index WHERE ${where} AND fail_reason IS NOT NULL GROUP BY fail_reason ORDER BY n DESC`, p)
  const [byVersion] = await pool.query(`SELECT prompt_version AS version, COUNT(*) AS total, SUM(CASE WHEN fail_reason IS NOT NULL THEN 1 ELSE 0 END) AS failed FROM optimizer_convo_index WHERE ${where} GROUP BY prompt_version ORDER BY total DESC LIMIT 8`, p)
  const [sugTop] = await pool.query(`SELECT code, title, frequency, severity, status, problem_type FROM optimizer_suggestions WHERE ${where} ORDER BY frequency DESC LIMIT 8`, p)
  const [sugByStatus] = await pool.query(`SELECT status, COUNT(*) AS n FROM optimizer_suggestions WHERE ${where} GROUP BY status`, p)
  const [runs] = await pool.query(`SELECT started_at, finished_at, convos_processed, suggestions_new FROM optimizer_runs WHERE ${where} AND status='done' ORDER BY started_at DESC LIMIT 10`, p)
  const sugStatus = {}; for (const r of sugByStatus) sugStatus[r.status] = r.n
  const n = v => Number(v) || 0
  return {
    kpis: {
      total: n(tot?.total), resolved: n(tot?.resolved), failed: n(tot?.failed), abandoned: n(tot?.abandoned),
      resolutionRate: tot?.total ? Math.round((n(tot.resolved) / n(tot.total)) * 100) : 0,
      avgConfidence: tot?.avgConf != null ? Number(Number(tot.avgConf).toFixed(2)) : null,
    },
    byTopic: byTopic.map(t => ({ topic: t.topic || 'general', total: n(t.total), resolved: n(t.resolved), failed: n(t.failed), abandoned: n(t.abandoned) })),
    byFail: byFail.map(f => ({ reason: f.reason, n: n(f.n) })),
    byVersion: byVersion.map(v => ({ version: v.version, total: n(v.total), failed: n(v.failed) })),
    suggestionsTop: sugTop,
    suggestionsByStatus: sugStatus,
    runs: runs.reverse().map(r => ({ at: r.finished_at || r.started_at, convos: n(r.convos_processed), newSug: n(r.suggestions_new) })),
  }
}

module.exports = { run, getStatus, getSuggestions, setSuggestionStatus, getDashboard, activePromptVersion }
