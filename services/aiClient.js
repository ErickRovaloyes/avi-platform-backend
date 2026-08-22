'use strict'
/**
 * AVI Platform — Unified AI Client (backend port)
 *
 * Port server-side del cliente de IA del frontend. Soporta OpenAI y DeepSeek
 * (compatible OpenAI). Usa fetch nativo de Node 18+.
 *
 * Solo se incluye lo que el motor de flujos necesita en el servidor:
 *   chat(), detectProvider(), getApiKey() + helpers de construcción de body.
 *
 * Anthropic (Claude) se retiró de la plataforma. Los ids `claude-*` que quedaran guardados
 * en prompts o backups antiguos se resuelven a `OPENAI_DEFAULT` en vez de reventar —
 * ver `normalizeModel()`.
 */

// ─── Provider config ──────────────────────────────────────────────────────────
const PROVIDERS = {
  openai: {
    id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5',          name: 'GPT-5',           supportsTools: true,  supportsStream: true,  contextWindow: 400000 },
      { id: 'gpt-5-mini',     name: 'GPT-5 mini',      supportsTools: true,  supportsStream: true,  contextWindow: 400000 },
      { id: 'gpt-5-nano',     name: 'GPT-5 nano',      supportsTools: true,  supportsStream: true,  contextWindow: 400000 },
      { id: 'gpt-4.1',        name: 'GPT-4.1',         supportsTools: true,  supportsStream: true,  contextWindow: 1047576 },
      { id: 'gpt-4.1-mini',   name: 'GPT-4.1 mini',    supportsTools: true,  supportsStream: true,  contextWindow: 1047576 },
      { id: 'gpt-4.1-nano',   name: 'GPT-4.1 nano',    supportsTools: true,  supportsStream: true,  contextWindow: 1047576 },
      { id: 'gpt-4o',         name: 'GPT-4o',          supportsTools: true,  supportsStream: true,  contextWindow: 128000 },
      { id: 'gpt-4o-mini',    name: 'GPT-4o mini',     supportsTools: true,  supportsStream: true,  contextWindow: 128000 },
      { id: 'o3',             name: 'o3',       supportsTools: true,  supportsStream: false, isReasoning: true, contextWindow: 200000 },
      { id: 'o3-mini',        name: 'o3-mini',  supportsTools: true,  supportsStream: false, isReasoning: true, contextWindow: 200000 },
      { id: 'o4-mini',        name: 'o4-mini',  supportsTools: true,  supportsStream: false, isReasoning: true, contextWindow: 200000 },
      { id: 'o1',             name: 'o1',       supportsTools: false, supportsStream: false, isReasoning: true, contextWindow: 200000 },
      { id: 'o1-mini',        name: 'o1-mini',  supportsTools: false, supportsStream: false, isReasoning: true, contextWindow: 128000 },
    ],
    keyField: 'openaiKey',
  },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    models: [
      // La API de DeepSeek ahora SOLO acepta 'deepseek-v4-pro'/'deepseek-v4-flash'
      // (deprecó 'deepseek-chat'/'deepseek-reasoner'). Las etiquetas v4 ya son los
      // nombres reales del API; los ids antiguos se redirigen vía apiModel para no
      // romper prompts/cuentas que aún los tengan guardados.
      // Contexto 1M y salida máxima 384K: https://api-docs.deepseek.com/quick_start/pricing
      // (comprobado el 2026-08-22). Antes figuraba 128K, de la generación anterior.
      { id: 'deepseek-v4-pro',   name: 'DeepSeek V4 Pro',       supportsTools: true, supportsStream: true,  contextWindow: 1000000, maxOutput: 384000 },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash',     supportsTools: true, supportsStream: true,  contextWindow: 1000000, maxOutput: 384000 },
      { id: 'deepseek-chat',     name: 'DeepSeek Chat (legado)',     apiModel: 'deepseek-v4-flash', supportsTools: true, supportsStream: true, contextWindow: 1000000, maxOutput: 384000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (legado)', apiModel: 'deepseek-v4-pro',   supportsTools: true, supportsStream: true, contextWindow: 1000000, maxOutput: 384000 },
    ],
    keyField: 'deepseekKey',
  },
}

// Modelo por defecto de cada proveedor. Son los dos únicos que la plataforma elige sola:
// la política de Google (services/aiModelPolicy.js) alterna entre ellos según la conexión.
const OPENAI_DEFAULT   = 'gpt-5-mini'
const DEEPSEEK_DEFAULT = 'deepseek-v4-flash'

function getProvider(providerId) { return PROVIDERS[providerId] || PROVIDERS.openai }
function getModel(providerId, modelId) {
  const provider = getProvider(providerId)
  return provider.models.find(m => m.id === modelId) || provider.models[0]
}
function getApiKey(account, providerId) {
  const provider = getProvider(providerId)
  return account?.[provider.keyField] || ''
}

// ── Restos de Claude ──────────────────────────────────────────────────────────
// Una migración de arranque reescribe los prompts guardados, pero eso no cubre lo que
// llegue DESPUÉS: un backup restaurado, un flujo exportado, un ajuste de plataforma que
// nadie tocó. Sin esto, un id `claude-*` se mandaría tal cual a la API de OpenAI y el
// asistente fallaría con un error incomprensible.
function isLegacyClaude(modelId) { return String(modelId || '').toLowerCase().startsWith('claude') }

// Devuelve el par { provider, model } que se debe usar de verdad.
function normalizeModel(providerId, modelId) {
  if (providerId === 'anthropic' || isLegacyClaude(modelId)) {
    return { provider: 'openai', model: OPENAI_DEFAULT }
  }
  return { provider: providerId, model: modelId }
}

function detectProvider(modelId = '') {
  const m = String(modelId).toLowerCase()
  if (m.startsWith('deepseek')) return 'deepseek'
  return 'openai'   // incluye los `claude-*` legados, que normalizeModel() reconduce
}

const DEFAULT_ADVANCED = {
  maxTokens: 4096, temperature: 0.7, topP: 1, topK: null,
  presencePenalty: 0, frequencyPenalty: 0, seed: null, stopSequences: [],
  reasoningEffort: 'medium', extendedThinking: false, thinkingBudgetTokens: 5000,
}

function buildOpenAIBody({ model, messages, tools, modelConfig, advanced = {}, provider }) {
  const isReasoning = modelConfig.isReasoning
  const isOpenAI = provider === 'openai'
  // OpenAI (gpt-5 y serie o) EXIGE `max_completion_tokens` y ya no acepta `max_tokens`.
  // gpt-4o/4.1 también aceptan `max_completion_tokens`. DeepSeek (compat clásica) usa `max_tokens`.
  const tokenParam = isOpenAI ? 'max_completion_tokens' : 'max_tokens'
  // gpt-5 y serie o solo aceptan la temperatura por defecto (1) → no la enviamos.
  const onlyDefaultTemp = isReasoning || (isOpenAI && /^gpt-5/i.test(String(model)))
  const body = {
    model,
    messages: isReasoning && isOpenAI
      ? messages.map(m => m.role === 'system' ? { ...m, role: 'developer' } : m)
      : messages,
    [tokenParam]: advanced.maxTokens ?? DEFAULT_ADVANCED.maxTokens,
  }
  if (!isReasoning) {
    if (!onlyDefaultTemp) body.temperature = advanced.temperature ?? DEFAULT_ADVANCED.temperature
    if (advanced.topP != null)             body.top_p             = advanced.topP
    if (advanced.presencePenalty != null)  body.presence_penalty  = advanced.presencePenalty
    if (advanced.frequencyPenalty != null) body.frequency_penalty = advanced.frequencyPenalty
    if (advanced.seed != null)             body.seed              = advanced.seed
    if (advanced.stopSequences?.length)    body.stop              = advanced.stopSequences
  } else if (provider === 'openai' && advanced.reasoningEffort) {
    body.reasoning_effort = advanced.reasoningEffort
  }
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto' }
  return body
}

/**
 * Send a chat completion. Returns a string normally, or
 * { message, finish_reason } when tools are involved (OpenAI shape).
 * No streaming server-side (the flow waits for the full response).
 *
 * `onFinish({ finishReason, maxTokens })` (opcional) avisa del motivo de parada del proveedor.
 * Sirve para detectar respuestas TRUNCADAS (`finishReason === 'length'`), que de otro modo se
 * descartan en la rama sin herramientas. No cambia el tipo de retorno.
 */
async function chat({ provider = 'openai', model, apiKey, messages, tools = [], advanced = {}, maxTokens, temperature, onUsage, onFinish, signal }) {
  const adv = { ...DEFAULT_ADVANCED, ...advanced }
  if (maxTokens   != null) adv.maxTokens   = maxTokens
  if (temperature != null) adv.temperature = temperature

  // Reconduce cualquier resto de Claude antes de resolver proveedor y clave.
  ;({ provider, model } = normalizeModel(provider, model))

  const providerConfig = getProvider(provider)
  const modelConfig    = getModel(provider, model)
  // Algunos ids son etiquetas de la plataforma; resolvemos al modelo real de la API.
  const apiModel       = modelConfig.apiModel || model
  if (!apiKey) throw new Error(`NO_KEY:${provider}`)

  const useTools = tools.length > 0 && modelConfig.supportsTools

  // ── OpenAI / DeepSeek branch (la única que queda) ──────────────────────
  const body = buildOpenAIBody({ model: apiModel, messages, tools: useTools ? tools : [], modelConfig, advanced: adv, provider })
  const res = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(`[${providerConfig.name}] ${errData?.error?.message || `HTTP ${res.status}`}`)
  }
  const data = await res.json()
  const choice = data.choices?.[0]
  if (onUsage && data.usage) {
    onUsage({ promptTokens: data.usage.prompt_tokens || 0, completionTokens: data.usage.completion_tokens || 0 })
  }
  // OpenAI/DeepSeek: finish_reason 'length' = respuesta truncada por el techo de tokens.
  if (onFinish) onFinish({ finishReason: choice?.finish_reason, maxTokens: adv.maxTokens })
  if (useTools) return { message: choice?.message, finish_reason: choice?.finish_reason }
  return choice?.message?.content || ''
}

module.exports = {
  PROVIDERS, getProvider, getModel, getApiKey, detectProvider, chat,
  OPENAI_DEFAULT, DEEPSEEK_DEFAULT, isLegacyClaude, normalizeModel,
}
