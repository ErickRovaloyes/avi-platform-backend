'use strict'
const pool   = require('../db')
const mammoth = require('mammoth')
const { parseJ } = require('../utils')
const { recordUsageInternal, getPricingMap } = require('./analytics.controller')
const { normalizeModel } = require('../services/aiClient')

// ── Real token counting ─────────────────────────────────────────────────────
// Uses gpt-tokenizer (cl100k_base / o200k_base) for OpenAI + DeepSeek.

let _gptTok = null
function getGptTokenizer() {
  if (_gptTok) return _gptTok
  try { _gptTok = require('gpt-tokenizer') } catch { _gptTok = null }
  return _gptTok
}

// Count tokens locally for OpenAI/DeepSeek (DeepSeek uses a similar BPE).
// Falls back to char/4 heuristic if the tokenizer is unavailable.
function countOpenAITokens(text) {
  const tok = getGptTokenizer()
  if (tok?.encode) {
    try { return tok.encode(String(text || '')).length } catch { /* fall through */ }
  }
  return Math.ceil(String(text || '').length / 4)
}

// ── Provider detection ──────────────────────────────────────────────────────

function detectProvider(model) {
  if (!model) return 'openai'
  const m = model.toLowerCase()
  if (m.startsWith('deepseek'))  return 'deepseek'
  return 'openai'   // los `claude-*` legados caen aquí y callAI los reconduce
}

function getProviderKey(provider, account) {
  if (provider === 'deepseek')  return account?.deepseek_key  || ''
  return account?.openai_key || ''
}

// Returns the API key to use for the given provider, with platform-default fallback.
async function resolveProviderKey(accountId, provider) {
  if (accountId) {
    const [[acc]] = await pool.query('SELECT openai_key, deepseek_key FROM accounts WHERE id=?', [accountId])
    const own = getProviderKey(provider, acc)
    if (own && own.trim()) return { key: own, source: 'account' }
  }
  const [[pf]] = await pool.query('SELECT openai_key, deepseek_key FROM platform_settings WHERE id=1')
  const pk = getProviderKey(provider, pf)
  if (pk && pk.trim()) return { key: pk, source: 'platform' }
  return { key: '', source: 'none' }
}

// ── Text extraction helpers ──────────────────────────────────────────────────

async function extractDocxText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer })
  return (value || '').replace(/\s+/g, ' ').trim()
}

function extractPdfText(buffer) {
  const str = buffer.toString('latin1')
  let text = ''
  const btEt = /BT([\s\S]*?)ET/g
  let m
  while ((m = btEt.exec(str)) !== null) {
    const block = m[1]
    const strRe = /\(([^)\\]*(\\.[^)\\]*)*)\)\s*Tj/g
    const arrRe = /\[([^\]]*)\]\s*TJ/g
    let inner
    while ((inner = strRe.exec(block)) !== null) text += decodePdfString(inner[1]) + ' '
    while ((inner = arrRe.exec(block)) !== null) {
      const parts = inner[1].match(/\(([^)\\]*(\\.[^)\\]*)*)\)/g) || []
      text += parts.map(p => decodePdfString(p.slice(1, -1))).join('') + ' '
    }
  }
  return text.replace(/\s+/g, ' ').trim()
}

function decodePdfString(s) {
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
}

// ── Provider-agnostic AI call ───────────────────────────────────────────────

async function callAI({ provider, model, apiKey, systemPrompt, userPrompt, maxTokens = 4000, temperature = 0.6, jsonMode = false }) {
  // Claude salió de la plataforma. Un ajuste guardado que aún apunte a `claude-*` (o a
  // 'anthropic') se reconduce al modelo por defecto de OpenAI en vez de fallar.
  ;({ provider, model } = normalizeModel(provider, model))
  // OpenAI + DeepSeek share the same Chat Completions schema
  return callOpenAICompatible({ provider, model, apiKey, systemPrompt, userPrompt, maxTokens, temperature, jsonMode })
}

async function callOpenAICompatible({ provider, model, apiKey, systemPrompt, userPrompt, maxTokens, temperature, jsonMode }) {
  const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'
  const isReasoning = /^o\d|reasoner/.test(model)
  const tokenParam = isReasoning ? 'max_completion_tokens' : 'max_tokens'

  const body = {
    model,
    messages: [
      { role: isReasoning && provider === 'openai' ? 'developer' : 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    [tokenParam]: maxTokens,
    ...(isReasoning ? {} : { temperature }),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(`[${provider}] ${errData?.error?.message || `HTTP ${res.status}`}`)
  }
  const data = await res.json()
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
    },
  }
}
// Extract a JSON object from a string that might contain prose around it
function extractJson(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  // Try to find a JSON block delimited by ```json ... ``` or the first { ... }
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()) } catch {}
  }
  // Greedy match for the largest top-level object
  const start = text.indexOf('{')
  const end   = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  return null
}

// Extrae el valor de la clave "prompt" recorriendo el texto carácter a carácter (respetando
// escapes), AUN CUANDO el JSON tenga saltos de línea/tabs sin escapar que rompen JSON.parse.
// Causa raíz típica de que se guardara el JSON crudo como prompt en las cuentas nuevas/demo.
function extractPromptField(text) {
  const raw = String(text || '')
  const keyPos = raw.search(/"prompt"\s*:/)
  if (keyPos === -1) return ''
  const colon = raw.indexOf(':', keyPos)
  let i = raw.indexOf('"', colon + 1)
  if (i === -1) return ''
  i++ // primer carácter del valor de la cadena
  let out = ''
  for (; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\') {
      const nx = raw[i + 1]
      if (nx === 'n') out += '\n'
      else if (nx === 't') out += '\t'
      else if (nx === 'r') out += '\r'
      else if (nx === '"') out += '"'
      else if (nx === '\\') out += '\\'
      else if (nx === '/') out += '/'
      else if (nx === 'u') { out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16) || 0); i += 4 }
      else out += nx || ''
      i++
      continue
    }
    if (ch === '"') {
      // ¿Es la comilla de cierre real? Lo siguiente (ignorando espacios) debe ser , o }
      const rest = raw.slice(i + 1).replace(/^\s+/, '')
      if (rest === '' || rest[0] === ',' || rest[0] === '}') break
      out += '"' // comilla sin escapar DENTRO del texto → conservarla
      continue
    }
    out += ch
  }
  return out.trim()
}

// Recupera el SYSTEM PROMPT de la respuesta del generador. Devuelve '' si es un envoltorio JSON
// irrecuperable (para que el llamador use el fallback determinista en vez de guardar JSON crudo).
function extractGeneratedPrompt(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const obj = extractJson(raw)                                    // 1) JSON válido (o en ```json)
  if (obj && typeof obj.prompt === 'string' && obj.prompt.trim()) return obj.prompt.trim()
  const viaField = extractPromptField(raw)                        // 2) JSON malformado: rescatar "prompt"
  if (viaField) return viaField
  const looksJson = /^\s*[{[]/.test(raw) || /"prompt"\s*:/.test(raw)
  if (!looksJson) return raw                                      // 3) texto plano (no era JSON) → úsalo
  return ''                                                       // 4) envoltorio JSON irrecuperable
}

// ── Pick an API key for the configured generator model ──────────────────────

async function pickAccountForProvider(accountId, provider) {
  // Account own → platform-default fallback. No longer rummages across other accounts.
  const r = await resolveProviderKey(accountId, provider)
  return { account: null, apiKey: r.key, source: r.source }
}

// ── Endpoint: generate prompt from uploaded document ────────────────────────

const generateFromDoc = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { accountId, agentName = 'Agente sin nombre', observations = '' } = req.body
  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' })

  try {
    // Load platform settings
    const [[settings]] = await pool.query('SELECT * FROM platform_settings WHERE id=1')

    // Enforce the super-admin-configured file size limit (default 30 MB).
    const maxFileMb = settings?.prompt_generator_max_file_mb || 30
    if (req.file.size > maxFileMb * 1024 * 1024) {
      return res.status(413).json({ error: `Archivo excede el límite de ${maxFileMb} MB configurado por el administrador` })
    }

    const model       = settings?.prompt_generator_model || 'gpt-4o'
    const structure   = settings?.prompt_generator_structure || ''
    const conditions  = settings?.prompt_generator_conditions || ''
    const maxTokens   = parseInt(settings?.prompt_generator_max_tokens) || 8000
    const temperature = settings?.prompt_generator_temperature != null ? Number(settings.prompt_generator_temperature) : 0.55
    const maxDocChars = parseInt(settings?.prompt_generator_max_doc_chars) || 200000
    const allowFlows  = settings?.prompt_generator_allow_flows !== 0

    const provider = detectProvider(model)
    const { apiKey } = await pickAccountForProvider(accountId, provider)
    if (!apiKey) {
      const providerLabel = { openai: 'OpenAI', deepseek: 'DeepSeek' }[provider]
      return res.status(400).json({ error: `Para usar el modelo "${model}" se requiere una API Key de ${providerLabel} configurada en alguna cuenta` })
    }

    // Extract text from file
    const filename = req.file.originalname || ''
    const ext = filename.split('.').pop().toLowerCase()
    let docText = ''
    if (ext === 'docx' || ext === 'doc') {
      docText = await extractDocxText(req.file.buffer)
    } else if (ext === 'pdf') {
      docText = extractPdfText(req.file.buffer)
    } else if (ext === 'txt' || ext === 'md') {
      docText = req.file.buffer.toString('utf-8')
    } else {
      return res.status(400).json({ error: `Formato no soportado: .${ext}. Usa .docx, .pdf, .txt o .md` })
    }
    if (!docText || docText.length < 50) {
      return res.status(400).json({ error: 'No se pudo extraer texto del documento o es demasiado corto' })
    }

    // Use the full document up to the configured limit (default 200k chars ≈ 50k tokens)
    const truncated = docText.length > maxDocChars
    const docExcerpt = docText.slice(0, maxDocChars)

    // ── Generator system prompt (uses configurable conditions + observations) ──
    const sysPrompt = `Eres un PROMPT ENGINEER SENIOR especializado en construir agentes de IA conversacionales empresariales de alto desempeño para atención al cliente, ventas, soporte técnico y operaciones.

Tu misión es generar un SYSTEM PROMPT EXTREMADAMENTE DETALLADO y PROFESIONAL en español para un agente IA llamado "${agentName}", basándote RIGUROSAMENTE en el documento proporcionado. El prompt debe reflejar la TOTALIDAD de la información relevante del documento — no resumas en exceso ni omitas datos importantes.

═══════════════════════════════════════════════════════════════════
CONDICIONES Y ESTÁNDARES DE CALIDAD (configuradas por el administrador)
═══════════════════════════════════════════════════════════════════

${conditions || '[Usa tu mejor criterio profesional]'}

═══════════════════════════════════════════════════════════════════
ESTRUCTURA BASE QUE DEBE SEGUIR EL PROMPT
═══════════════════════════════════════════════════════════════════

"""
${structure || '[Usa tu mejor criterio profesional]'}
"""

${observations && observations.trim() ? `═══════════════════════════════════════════════════════════════════
OBSERVACIONES ESPECÍFICAS PARA ESTE PROMPT
═══════════════════════════════════════════════════════════════════

Aplica estas observaciones del super administrador con MÁXIMA PRIORIDAD. Si entran en conflicto con las condiciones generales, ESTAS observaciones ganan:

"""
${observations.trim()}
"""

` : ''}═══════════════════════════════════════════════════════════════════
COBERTURA COMPLETA DEL DOCUMENTO (obligatorio)
═══════════════════════════════════════════════════════════════════

El prompt generado DEBE incorporar TODA la información relevante del documento, incluyendo:
- Todos los productos, servicios, planes y precios mencionados
- Todas las políticas, plazos, condiciones, garantías y restricciones
- Todas las preguntas frecuentes y sus respuestas explícitas
- Todos los procedimientos, pasos y flujos de trabajo descritos
- Toda la información de contacto, horarios, ubicaciones y datos de la empresa
- Cualquier dato técnico, métrica, característica o especificación relevante

Si el documento contiene tablas, listas o numeraciones, REPRODUCE su contenido íntegro en el prompt (no digas "ver tabla" — incluye los datos). El agente debe poder responder cualquier pregunta razonable basándose SOLO en el prompt generado, sin necesidad de consultar el documento original.

═══════════════════════════════════════════════════════════════════
FLUJOS CONVERSACIONALES
═══════════════════════════════════════════════════════════════════

${allowFlows
  ? `Adicionalmente debes proponer entre 3 y 6 FLUJOS automatizados que complementen al agente. Cada flujo debe tener:
- name: nombre claro
- trigger: uno de "conversation_start", "keyword", "manual"
- description: 1-2 frases explicando qué hace
- steps: array de 3 a 8 pasos (cada paso es un mensaje o acción que enviará el agente automáticamente).

Sugiere flujos relevantes al negocio descrito en el documento (ej: bienvenida con presentación, captura de datos del lead, derivación a asesor humano, recordatorio de seguimiento, FAQ específica, etc).`
  : 'NO incluyas sugerencias de flujos (configuración deshabilitada). Devuelve "flows": [] en la respuesta.'}

═══════════════════════════════════════════════════════════════════
FORMATO DE RESPUESTA — JSON ESTRICTO
═══════════════════════════════════════════════════════════════════

Responde ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después, sin bloques markdown):

{
  "prompt": "el system prompt completo y extenso, en una sola cadena con saltos de línea \\n",
  "summary": "2-3 frases describiendo qué hace este agente, para quién y cuál es su valor",
  "flows": ${allowFlows ? '[ { "name": "...", "trigger": "conversation_start|keyword|manual", "description": "...", "steps": ["paso 1", "paso 2", "..."] } ]' : '[]'}
}

VERIFICACIÓN FINAL ANTES DE ENVIAR:
- ¿El prompt refleja TODA la información clave del documento? Si no, expándelo.
- ¿Cumple TODAS las condiciones configuradas? Si no, corrígelo.
- ¿Aplica las observaciones específicas del super administrador? Si no, ajústalo.
- ¿Incluye datos REALES del documento (no placeholders)? Si no, revísalo.
- ¿El JSON es válido y NO incluye texto fuera de él? Si no, corrígelo.`

    const userMsg = `Documento de referencia para construir el agente "${agentName}":

${truncated ? `[NOTA: El documento original tiene ${docText.length.toLocaleString()} caracteres pero se procesará hasta ${maxDocChars.toLocaleString()}. Si tu modelo soporta más contexto, el super admin puede ampliar este límite. Aún así, extrae TODO el valor posible del fragmento procesado.]\n\n` : ''}═══ INICIO DEL DOCUMENTO ═══
${docExcerpt}
═══ FIN DEL DOCUMENTO ═══

Genera ahora el system prompt completo, exhaustivo y fiel al documento, siguiendo TODAS las condiciones, la estructura base y las observaciones específicas.`

    // OpenAI y DeepSeek aceptan response_format=json_object, que hace el parseo más seguro.
    const useJsonMode = true

    const aiResult = await callAI({
      provider, model, apiKey,
      systemPrompt: sysPrompt,
      userPrompt: userMsg,
      maxTokens, temperature,
      jsonMode: useJsonMode,
    })
    const aiText = aiResult.text || ''

    // Record token usage server-side (fire-and-forget)
    recordUsageInternal({
      accId: accountId, agentId: null, conversationId: null,
      provider, model,
      promptTokens: aiResult.usage?.promptTokens || 0,
      completionTokens: aiResult.usage?.completionTokens || 0,
      source: 'prompt-generator',
    })

    const parsed = extractJson(aiText)
    // Recupera el prompt incluso si el JSON viene malformado (saltos de línea sin escapar).
    const prompt = (parsed && typeof parsed.prompt === 'string' && parsed.prompt.trim())
      ? parsed.prompt.trim() : extractGeneratedPrompt(aiText)
    if (!prompt) {
      return res.status(500).json({ error: 'La IA no devolvió un prompt válido', raw: aiText.slice(0, 500) })
    }

    res.json({
      prompt,
      summary: parsed?.summary || '',
      flows: Array.isArray(parsed?.flows) ? parsed.flows : [],
      docCharCount: docText.length,
      charsProcessed: docExcerpt.length,
      truncated,
      model,
      provider,
      hadObservations: !!(observations && observations.trim()),
    })
  } catch (err) {
    console.error('[PROMPT GENERATOR]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

// ── Endpoint: classify a change request (cheap pre-flight) ───────────────────

/**
 * Cuántos tokens va a ocupar la respuesta del Agente de Cambios.
 *
 * El agente devuelve el prompt ENTERO reescrito, así que la salida es «el prompt de ahora, más
 * lo que se le añada». Esta función solo miraba el prompt de ahora y la categoría, con la
 * suposición de que un cambio añade poco. Esa suposición se rompe en cuanto alguien adjunta un
 * documento y pide incorporarlo: el prompt crece por el tamaño del documento, no por el factor
 * de la categoría. El síntoma era pedir ~6 800 tokens para una respuesta que necesitaba el doble,
 * y perder la llamada entera con un aviso de «se cortó por tamaño».
 *
 * `añadidoTokens` es el material nuevo que viaja en la instrucción (texto del documento incluido).
 * No todo acaba dentro del prompt —parte es el encargo en sí, y el modelo resume— pero contarlo
 * de menos es lo que costaba la llamada, así que se cuenta entero.
 *
 * @param {'basic'|'medium'|'complex'} category
 * @param {number} currentPromptTokens  Tamaño del prompt actual.
 * @param {number} añadidoTokens        Material nuevo que se pide incorporar.
 */
function estimateOutputTokens(category, currentPromptTokens, añadidoTokens = 0) {
  const base = (currentPromptTokens || 0) + Math.max(0, añadidoTokens || 0)
  if (category === 'basic')   return Math.max(200,  Math.round(base * 1.1))   // small tweaks
  if (category === 'complex') return Math.max(2000, Math.round(base * 1.6))   // full rewrite + growth
  return Math.max(800, Math.round(base * 1.3))                                // medium refactor
}

const CHANGE_AGENT_SYSTEM_PROMPT = (currentPrompt) => `Eres un experto en prompt engineering para agentes de IA conversacionales de servicio al cliente.

Tu tarea es ayudar al usuario a modificar el system prompt de su agente de IA. El usuario te describirá en lenguaje natural los cambios que quiere realizar.

El system prompt ACTUAL del agente es:
"""
${currentPrompt}
"""

Responde SIEMPRE con este formato exacto:
1. Una o dos líneas explicando brevemente qué cambios realizaste.
2. El prompt completo y modificado entre las etiquetas <prompt> y </prompt>.`

const classifyChange = async (req, res) => {
  const { accId } = req.params
  const {
    instruction = '',
    currentPromptText = '',
    currentPromptLength = 0,
    // El historial del chat viaja TAMBIÉN en la llamada real (ver ChangeAgentPanel), y no se
    // contaba: en un refinamiento eso es mucho, y el estimado salía corto sin motivo aparente.
    historyText = '',
  } = req.body
  if (!instruction.trim()) return res.status(400).json({ error: 'Instrucción requerida' })

  try {
    // Load the platform-wide Change Agent model + API key for that provider
    const [[settings]] = await pool.query('SELECT change_agent_model FROM platform_settings WHERE id=1')
    const model    = settings?.change_agent_model || 'gpt-4o-mini'
    const provider = detectProvider(model)

    // Resolve API key with platform fallback. Even without a key we still want to
    // estimate (using the local tokenizer) so the user sees real numbers.
    const { key: apiKey } = await resolveProviderKey(accId, provider)
    const { key: openaiKeyForClassifier } = await resolveProviderKey(accId, 'openai')

    // ── REAL input token count for the actual Change Agent call ───────────
    // The Change Agent will be called with:
    //   system: CHANGE_AGENT_SYSTEM_PROMPT(currentPromptText)
    //   user:   instruction
    const currentPrompt = currentPromptText || ' '.repeat(currentPromptLength)
    const sysForChangeAgent = CHANGE_AGENT_SYSTEM_PROMPT(currentPrompt)

    // Solo quedan OpenAI y DeepSeek, y ambos usan la misma BPE: el tokenizador local vale
    // para los dos. (Antes había además una llamada de red al contador oficial de Anthropic.)
    const inputTokens = countOpenAITokens(sysForChangeAgent)
      + countOpenAITokens(instruction)
      + countOpenAITokens(historyText)
      + 8 // ~8 tokens of overhead per call
    const tokenizer = getGptTokenizer()?.encode ? 'tiktoken' : 'estimate'

    // ── Cheap LLM classification (OpenAI gpt-4o-mini) ─────────────────────
    // Fall back to a heuristic if no OpenAI key is available (own + platform).
    let category = 'medium'
    let reason   = 'Clasificación heurística (sin API Key OpenAI disponible)'
    // Sugerencias de qué precisar para que un cambio grande quede bien (vacío en los básicos).
    let suggestions = []
    if (openaiKeyForClassifier) {
      try {
        const sysPrompt = `Eres un clasificador de cambios sobre prompts de IA.
Clasifica el cambio solicitado en EXACTAMENTE una de:
- "basic": cambio puntual menor (añadir una frase, cambiar tono, traducir un párrafo, ajustar formato)
- "medium": reescribir o reorganizar una o varias secciones (refactor parcial, añadir nuevas instrucciones)
- "complex": replantear el prompt entero, redefinir el agente, cambios estructurales mayores

Además, si el cambio es "medium" o "complex", propón entre 2 y 4 SUGERENCIAS concretas y accionables
de qué debería precisar el usuario para que el cambio quede bien (datos que faltan, decisiones que
conviene tomar, casos límite a cubrir). Cada sugerencia: una sola frase, en español, en segunda persona
("Indica…", "Define…", "Añade…"). Si el cambio es "basic", devuelve "suggestions": [].

Responde SOLO con JSON:
{ "category": "basic|medium|complex", "reason": "breve explicación", "suggestions": ["…", "…"] }`
        const aiResult = await callOpenAICompatible({
          provider: 'openai', model: 'gpt-4o-mini', apiKey: openaiKeyForClassifier,
          systemPrompt: sysPrompt, userPrompt: instruction,
          maxTokens: 150, temperature: 0.1, jsonMode: true,
        })
        recordUsageInternal({
          accId, agentId: null, conversationId: null,
          provider: 'openai', model: 'gpt-4o-mini',
          promptTokens: aiResult.usage?.promptTokens || 0,
          completionTokens: aiResult.usage?.completionTokens || 0,
          source: 'classify',
        })
        const parsed = extractJson(aiResult.text || '')
        if (parsed?.category && ['basic', 'medium', 'complex'].includes(parsed.category)) {
          category = parsed.category
          if (parsed.reason) reason = parsed.reason
        }
        if (Array.isArray(parsed?.suggestions)) {
          suggestions = parsed.suggestions
            .filter(x => typeof x === 'string' && x.trim())
            .slice(0, 4).map(x => x.trim().slice(0, 220))
        }
      } catch (e) { console.warn('[classify LLM]', e.message) }
    } else {
      // Heuristic: classify by instruction length + keyword cues
      const text = instruction.toLowerCase()
      const replanters = /(replantea|rehaz|reescribe todo|cambia por completo|conviér|redefin|nuevo agente|desde cero)/
      const sections   = /(añade secci|nueva regla|incorpora|estructura|incluye una secci|organiza)/
      if (replanters.test(text) || instruction.length > 200) category = 'complex'
      else if (sections.test(text) || instruction.length > 80) category = 'medium'
      else category = 'basic'
      reason = `Heurística: longitud ${instruction.length} chars + palabras-clave`
    }

    // ── Output tokens estimated from category + current prompt size ───────
    // La instrucción cuenta: cuando trae un documento adjunto («incorpora esto al prompt»), lo
    // que sale es el prompt de ahora MÁS ese documento. Mirar solo el prompt actual dejaba el
    // estimado a la mitad y la respuesta llegaba cortada.
    const currentPromptTokens = countOpenAITokens(currentPrompt)
    const añadidoTokens = countOpenAITokens(instruction)
    const estimatedOutputTokens = estimateOutputTokens(category, currentPromptTokens, añadidoTokens)
    const estimatedTokens = inputTokens + estimatedOutputTokens

    // ── Real USD cost based on the model pricing table ────────────────────
    const pricing = await getPricingMap()
    const p = pricing[model]
    let estimatedCostUsd = null
    if (p) {
      estimatedCostUsd = (inputTokens * p.inputPer1k / 1000) + (estimatedOutputTokens * p.outputPer1k / 1000)
    }

    res.json({
      category,
      reason,
      suggestions,
      inputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedCostUsd,
      tokenizer,
      model,
      provider,
    })
  } catch (err) {
    console.error('[CLASSIFY CHANGE]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

// ── Reusable: extract text from an uploaded file (docx/pdf/txt/md) ───────────
// Tolerant: returns '' on any failure so callers can fall back gracefully.
async function extractFileText(file) {
  if (!file || !file.buffer) return ''
  const ext = (file.originalname || '').split('.').pop().toLowerCase()
  try {
    if (ext === 'docx' || ext === 'doc') return await extractDocxText(file.buffer)
    if (ext === 'pdf')                    return extractPdfText(file.buffer)
    if (ext === 'txt' || ext === 'md')    return file.buffer.toString('utf-8')
  } catch { return '' }
  return ''
}

// ── Reusable: generate a default agent prompt for a NEW account ──────────────
// Uses the SAME generator parameters configured in Super Admin → Plataforma
// (estructura + condiciones de calidad), plus the account-creation form info
// (company/agent name, observations) and the optional uploaded document.
// Returns the prompt string, or null if there's no API key / the model fails
// (the caller then falls back to a deterministic prompt).
async function generateAccountPrompt({ accountId, agentName = 'Asistente', companyName = '', observations = '', docText = '' }) {
  const [[settings]] = await pool.query('SELECT * FROM platform_settings WHERE id=1')
  const model       = settings?.prompt_generator_model || 'gpt-4o'
  const structure   = settings?.prompt_generator_structure || ''
  const conditions  = settings?.prompt_generator_conditions || ''
  const maxTokens   = parseInt(settings?.prompt_generator_max_tokens) || 8000
  const temperature = settings?.prompt_generator_temperature != null ? Number(settings.prompt_generator_temperature) : 0.55
  const maxDocChars = parseInt(settings?.prompt_generator_max_doc_chars) || 200000

  const provider = detectProvider(model)
  const { apiKey } = await pickAccountForProvider(accountId, provider)
  if (!apiKey) return null

  const doc = (docText || '').slice(0, maxDocChars)

  const sysPrompt = `Eres un PROMPT ENGINEER SENIOR especializado en construir agentes de IA conversacionales empresariales de alto desempeño.

Tu misión es generar un SYSTEM PROMPT EXTREMADAMENTE DETALLADO y PROFESIONAL en español para un agente IA llamado "${agentName}"${companyName ? ` de la empresa "${companyName}"` : ''}.

═══════════════════════════════════════════════════════════════════
CONDICIONES Y ESTÁNDARES DE CALIDAD (configuradas por el administrador)
═══════════════════════════════════════════════════════════════════

${conditions || '[Usa tu mejor criterio profesional]'}

═══════════════════════════════════════════════════════════════════
ESTRUCTURA BASE QUE DEBE SEGUIR EL PROMPT
═══════════════════════════════════════════════════════════════════

"""
${structure || '[Usa tu mejor criterio profesional]'}
"""

${observations ? `═══════════════════════════════════════════════════════════════════
OBSERVACIONES ESPECÍFICAS (MÁXIMA PRIORIDAD)
═══════════════════════════════════════════════════════════════════

"""
${observations}
"""

` : ''}${doc
  ? 'Usa el DOCUMENTO de referencia para incorporar TODA la información relevante del negocio (productos, servicios, precios, políticas, FAQs, contacto, horarios). No digas "ver documento": incluye los datos.'
  : 'No se adjuntó documento. Genera un system prompt profesional, completo y listo para personalizar, siguiendo la estructura y las condiciones, adecuado para un asistente de atención/ventas de esta empresa.'}

Responde ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después, sin markdown):
{ "prompt": "el system prompt completo y extenso, en una sola cadena con saltos de línea \\n" }`

  const userMsg = doc
    ? `Empresa: ${companyName || '—'} · Agente: "${agentName}"

═══ INICIO DEL DOCUMENTO ═══
${doc}
═══ FIN DEL DOCUMENTO ═══

Genera ahora el system prompt completo, exhaustivo y fiel al documento, siguiendo la estructura, las condiciones y las observaciones.`
    : `Empresa: ${companyName || '—'} · Agente: "${agentName}"

Genera ahora el system prompt completo siguiendo la estructura base, las condiciones de calidad y las observaciones específicas.`

  try {
    const aiResult = await callAI({
      provider, model, apiKey,
      systemPrompt: sysPrompt, userPrompt: userMsg,
      maxTokens, temperature, jsonMode: true,
    })
    recordUsageInternal({
      accId: accountId, agentId: null, conversationId: null,
      provider, model,
      promptTokens: aiResult.usage?.promptTokens || 0,
      completionTokens: aiResult.usage?.completionTokens || 0,
      source: 'account-default-prompt',
    })
    // Recupera el prompt del JSON (tolerante a saltos de línea sin escapar). NUNCA guarda el
    // envoltorio JSON crudo: si es irrecuperable devuelve '' → el llamador usa el fallback.
    const prompt = extractGeneratedPrompt(aiResult.text || '')
    return prompt && prompt.length > 80 ? prompt : null
  } catch (e) {
    console.warn('[generateAccountPrompt]', e.message)
    return null
  }
}

// ── Adjuntar un archivo al Agente de Cambios ─────────────────────────────────
// Devuelve el TEXTO del documento para incorporarlo como contexto de la instrucción.
// Reutiliza extractFileText (mismo extractor del generador de prompts).
const MAX_CHANGE_DOC_CHARS = 60000
const extractForChange = async (req, res) => {
  const { accId } = req.params
  if (req.user?.type !== 'superadmin' && req.user?.accountId !== accId) {
    return res.status(403).json({ error: 'No autorizado' })
  }
  if (!req.file) return res.status(400).json({ error: 'No llegó el archivo' })
  try {
    const [[s]] = await pool.query('SELECT prompt_generator_max_file_mb FROM platform_settings WHERE id=1')
    const maxMb = s?.prompt_generator_max_file_mb || 30
    if (req.file.size > maxMb * 1024 * 1024) {
      return res.status(413).json({ error: `El archivo supera el límite de ${maxMb} MB` })
    }
    const text = await extractFileText(req.file)
    if (!text || text.length < 20) {
      return res.status(400).json({ error: 'No se pudo extraer texto del archivo. Usa .docx, .pdf, .txt o .md' })
    }
    const truncated = text.length > MAX_CHANGE_DOC_CHARS
    res.json({
      filename: req.file.originalname || 'documento',
      text: text.slice(0, MAX_CHANGE_DOC_CHARS),
      chars: text.length,
      truncated,
    })
  } catch (err) {
    console.error('[extractForChange]', err)
    res.status(500).json({ error: err.message || 'No se pudo leer el archivo' })
  }
}

module.exports = {
  generateFromDoc, classifyChange, extractFileText, generateAccountPrompt, extractForChange,
  // Expuesto para `pruebas/estimado-agente-cambios.test.js`: es la cuenta que se quedó corta.
  estimateOutputTokens,
  // Helpers reutilizables para otros generadores con IA (p. ej. diseño de flujos).
  callAI, detectProvider, resolveProviderKey, extractJson, extractGeneratedPrompt, extractPromptField,
}
