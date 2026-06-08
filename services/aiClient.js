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
      { id: 'deepseek-chat',     name: 'DeepSeek V3.2 (Chat)',   supportsTools: true, supportsStream: true,  contextWindow: 128000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1 (Reasoner)', supportsTools: true, supportsStream: true, isReasoning: true, contextWindow: 128000 },
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
  const tokenParam = isReasoning ? 'max_completion_tokens' : 'max_tokens'
  const body = {
    model,
    messages: isReasoning && provider === 'openai'
      ? messages.map(m => m.role === 'system' ? { ...m, role: 'developer' } : m)
      : messages,
    [tokenParam]: advanced.maxTokens ?? DEFAULT_ADVANCED.maxTokens,
  }
  if (!isReasoning) {
    body.temperature = advanced.temperature ?? DEFAULT_ADVANCED.temperature
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
 */
async function chat({ provider = 'openai', model, apiKey, messages, tools = [], advanced = {}, maxTokens, temperature, onUsage }) {
  const adv = { ...DEFAULT_ADVANCED, ...advanced }
  if (maxTokens   != null) adv.maxTokens   = maxTokens
  if (temperature != null) adv.temperature = temperature

  const providerConfig = getProvider(provider)
  const modelConfig    = getModel(provider, model)
  if (!apiKey) throw new Error(`NO_KEY:${provider}`)

  const useTools = tools.length > 0 && modelConfig.supportsTools

  // ── Anthropic branch ───────────────────────────────────────────────────
  if (provider === 'anthropic') {
    const systemPrompt = messages.find(m => m.role === 'system')?.content || ''
    const history = messages.filter(m => m.role !== 'system')
    const body = buildAnthropicBody({ model, systemPrompt, history, tools: useTools ? tools : [], advanced: adv })
    const res = await fetch(`${providerConfig.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}))
      throw new Error(`[${providerConfig.name}] ${errData?.error?.message || `HTTP ${res.status}`}`)
    }
    const data = await res.json()
    const text = (data.content || []).map(b => b.text || '').join('').trim()
    if (onUsage) onUsage({ promptTokens: data.usage?.input_tokens || 0, completionTokens: data.usage?.output_tokens || 0 })
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
  const body = buildOpenAIBody({ model, messages, tools: useTools ? tools : [], modelConfig, advanced: adv, provider })
  const res = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
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
  if (useTools) return { message: choice?.message, finish_reason: choice?.finish_reason }
  return choice?.message?.content || ''
}

module.exports = { PROVIDERS, getProvider, getModel, getApiKey, detectProvider, chat }
