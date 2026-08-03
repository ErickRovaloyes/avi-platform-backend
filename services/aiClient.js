'use strict'
/**
 * AVI Platform — Unified AI Client (backend port)
 *
 * Port server-side del cliente de IA del frontend. Soporta OpenAI, DeepSeek
 * (compatible OpenAI) y Anthropic (Claude). Usa fetch nativo de Node 18+.
 *
 * Solo se incluye lo que el motor de flujos necesita en el servidor:
 *   chat(), detectProvider(), getApiKey() + helpers de construcción de body.
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
      { id: 'deepseek-v4-pro',   name: 'DeepSeek V4 Pro',       supportsTools: true, supportsStream: true,  contextWindow: 128000 },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash',     supportsTools: true, supportsStream: true,  contextWindow: 128000 },
      { id: 'deepseek-chat',     name: 'DeepSeek Chat (legado)',     apiModel: 'deepseek-v4-flash', supportsTools: true, supportsStream: true, contextWindow: 128000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (legado)', apiModel: 'deepseek-v4-pro',   supportsTools: true, supportsStream: true, contextWindow: 128000 },
    ],
    keyField: 'deepseekKey',
  },
  anthropic: {
    id: 'anthropic', name: 'Claude (Anthropic)', baseUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-opus-4-7',           name: 'Claude Opus 4.7',   supportsTools: true, supportsStream: true, contextWindow: 200000 },
      { id: 'claude-sonnet-4-6',         name: 'Claude Sonnet 4.6', supportsTools: true, supportsStream: true, contextWindow: 200000 },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5',  supportsTools: true, supportsStream: true, contextWindow: 200000 },
    ],
    keyField: 'anthropicKey',
  },
}

function getProvider(providerId) { return PROVIDERS[providerId] || PROVIDERS.openai }
function getModel(providerId, modelId) {
  const provider = getProvider(providerId)
  return provider.models.find(m => m.id === modelId) || provider.models[0]
}
function getApiKey(account, providerId) {
  const provider = getProvider(providerId)
  return account?.[provider.keyField] || ''
}
function detectProvider(modelId = '') {
  const m = String(modelId).toLowerCase()
  if (m.startsWith('claude'))   return 'anthropic'
  if (m.startsWith('deepseek')) return 'deepseek'
  return 'openai'
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

function buildAnthropicBody({ model, systemPrompt, history, tools, advanced = {} }) {
  const inlineMessages = (history || []).filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }))
  const body = {
    model,
    max_tokens: advanced.maxTokens ?? DEFAULT_ADVANCED.maxTokens,
    temperature: advanced.temperature ?? DEFAULT_ADVANCED.temperature,
    system: systemPrompt || '',
    messages: inlineMessages.length ? inlineMessages : [{ role: 'user', content: '...' }],
  }
  if (advanced.topP != null) body.top_p = advanced.topP
  if (advanced.topK != null) body.top_k = advanced.topK
  if (advanced.stopSequences?.length) body.stop_sequences = advanced.stopSequences
  if (advanced.extendedThinking) body.thinking = { type: 'enabled', budget_tokens: advanced.thinkingBudgetTokens ?? 5000 }
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters,
    }))
  }
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

  const providerConfig = getProvider(provider)
  const modelConfig    = getModel(provider, model)
  // Algunos ids son etiquetas de la plataforma; resolvemos al modelo real de la API.
  const apiModel       = modelConfig.apiModel || model
  if (!apiKey) throw new Error(`NO_KEY:${provider}`)

  const useTools = tools.length > 0 && modelConfig.supportsTools

  // ── Anthropic branch ───────────────────────────────────────────────────
  if (provider === 'anthropic') {
    const systemPrompt = messages.find(m => m.role === 'system')?.content || ''
    const history = messages.filter(m => m.role !== 'system')
    const body = buildAnthropicBody({ model: apiModel, systemPrompt, history, tools: useTools ? tools : [], advanced: adv })
    const res = await fetch(`${providerConfig.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}))
      throw new Error(`[${providerConfig.name}] ${errData?.error?.message || `HTTP ${res.status}`}`)
    }
    const data = await res.json()
    const text = (data.content || []).map(b => b.text || '').join('').trim()
    if (onUsage) onUsage({ promptTokens: data.usage?.input_tokens || 0, completionTokens: data.usage?.output_tokens || 0 })
    // Anthropic: 'max_tokens' = respuesta truncada por el techo de tokens.
    if (onFinish) onFinish({ finishReason: data.stop_reason === 'max_tokens' ? 'length' : data.stop_reason, maxTokens: adv.maxTokens })
    if (useTools) {
      const tool_calls = (data.content || [])
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }))
      return {
        message: { role: 'assistant', content: text || null, tool_calls: tool_calls.length ? tool_calls : undefined },
        finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      }
    }
    return text
  }

  // ── OpenAI / DeepSeek branch ───────────────────────────────────────────
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

module.exports = { PROVIDERS, getProvider, getModel, getApiKey, detectProvider, chat }
