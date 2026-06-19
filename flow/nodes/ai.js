'use strict'
/**
 * AI category (backend port) — agente IA con memoria, clasificadores y utilidades.
 * Usa services/aiClient.chat con las keys efectivas de ctx.account.
 */

const { chat, detectProvider, getApiKey } = require('../../services/aiClient')
const { interpolate, sendBotMsg, logDebug, setVarBoth } = require('../common')
const store = require('../store')

const DEFAULT_MODEL = { openai: 'gpt-4o-mini', deepseek: 'deepseek-chat', anthropic: 'claude-sonnet-4-6' }

function buildOneToolDef(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name.replace(/\s+/g, '_').toLowerCase(),
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          (tool.collectFields || []).map(f => [
            f.paramName || f.label.replace(/\s+/g, '_').toLowerCase(),
            { type: 'string', description: f.label },
          ])
        ),
        required: (tool.collectFields || []).filter(f => f.required !== false).map(f => f.paramName || f.label.replace(/\s+/g, '_').toLowerCase()),
      },
    },
  }
}
// La herramienta especial "enviar_recurso" (actionType cms_resource) produce su
// propia definición con el catálogo de recursos. El resto usa la genérica.
function buildToolDefs(toolList, account) {
  return (toolList || [])
    .map(tool => (tool.actionType === 'cms_resource' ? buildResourceToolDef(account) : buildOneToolDef(tool)))
    .filter(Boolean)
}

async function execToolCall(ctx, toolList, toolName, toolArgs) {
  const normalized = toolName.replace(/\s+/g, '_').toLowerCase()
  const tool = (toolList || []).find(t => t.name.replace(/\s+/g, '_').toLowerCase() === normalized)
  if (!tool) return `Error: herramienta "${toolName}" no encontrada o no asignada a este prompt.`

  const results = []
  for (const field of (tool.collectFields || [])) {
    const paramName = field.paramName || field.label.replace(/\s+/g, '_').toLowerCase()
    const value = toolArgs?.[paramName]
    if (value !== undefined && field.variableId) {
      await setVarBoth(ctx, field.variableId, value)
      results.push(`${field.label}: "${value}" guardado`)
    }
  }

  if (tool.actionType === 'cms_resource') {
    return sendCmsResource(ctx, toolArgs)
  }
  if (tool.actionType === 'n8n' && tool.n8nIntegrationId) {
    try {
      const r = await store.dispatchN8N(tool.n8nIntegrationId, {
        tool: tool.name, args: toolArgs,
        _meta: { accountId: ctx.accId, agentId: ctx.agId, conversationId: ctx.convId, ts: Date.now() },
      }, { forceSync: true })
      if (!r?.ok) return `Error N8N: ${r?.error || 'desconocido'}`
      return typeof r.data === 'string' ? r.data : JSON.stringify(r.data || { ok: true })
    } catch (e) { return `Error N8N: ${e.message}` }
  }
  if (tool.actionType === 'flow' && tool.flowId) {
    const { executeFlow } = require('../engine')
    await executeFlow({ flowId: tool.flowId, accId: ctx.accId, agId: ctx.agId, convId: ctx.convId, triggerContext: { tool: tool.name, args: toolArgs } })
    return results.length ? results.join(', ') : 'Flujo ejecutado'
  }
  return results.length ? results.join(', ') : 'Ejecutado'
}

// ── Recursos del CMS: herramienta especial "enviar_recurso" ────────────────────
// Es una Herramienta IA Especial: se ASIGNA al prompt en la lista de herramientas
// (no está anclada al nodo). Cuando el prompt la tiene asignada, el modelo puede
// enviar imágenes/documentos del CMS. Soporta carpetas "super unidad" (un producto
// con varias fotos): sin detalle envía todas; con detalle busca la foto concreta.
function resourceBaseUrl() {
  return (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
}
const normResourceName = s => String(s || '').trim().toLowerCase()
function tokenize(s) {
  return normResourceName(s).split(/[^a-z0-9áéíóúñü]+/i).filter(w => w.length > 1)
}
// Puntúa cuántos tokens de la consulta aparecen en el texto (palabras largas pesan más).
function scoreText(queryTokens, text) {
  const t = normResourceName(text)
  let score = 0
  for (const qt of queryTokens) { if (qt && t.includes(qt)) score += qt.length >= 4 ? 2 : 1 }
  return score
}
function assetHaystack(a) { return `${a.name} ${a.description || ''} ${(a.tags || []).join(' ')} ${a.category || ''}` }
function pickBest(list, queryTokens) {
  let best = { asset: null, score: -1 }
  for (const a of list) { const sc = scoreText(queryTokens, assetHaystack(a)); if (sc > best.score) best = { asset: a, score: sc } }
  return best
}
function buildResourceToolDef(account) {
  const assets = account?.cmsAssets || []
  const folders = account?.cmsFolders || []
  if (!assets.length) return null
  const unitFolders = folders.filter(f => f.type === 'unit' && assets.some(a => a.folderId === f.id))
  const lines = []
  if (unitFolders.length) {
    lines.push('PRODUCTOS / SERVICIOS (cada uno agrupa varias fotos — al pedirlo se envían todas, o una concreta si el usuario especifica):')
    unitFolders.forEach(f => lines.push(`• ${f.name}${f.description ? ` — ${f.description}` : ''}`))
  }
  const loose = assets.filter(a => { const fol = folders.find(x => x.id === a.folderId); return !fol || fol.type !== 'unit' })
  if (loose.length) {
    lines.push('RECURSOS SUELTOS:')
    loose.slice(0, 60).forEach(a => lines.push(`• ${a.name}${a.description ? `: ${a.description}` : ''}${(a.tags || []).length ? ` [${a.tags.join(', ')}]` : ''}${a.category ? ` (${a.category})` : ''}`))
  }
  return {
    type: 'function',
    function: {
      name: 'enviar_recurso',
      description: `Envía al usuario imágenes o documentos del CMS. Úsalo cuando el usuario los pida o cuando ayuden (catálogo, lista de precios, foto de un producto/servicio, folleto, manual…). En "recurso" indica el producto/servicio o recurso de esta lista. Si es un PRODUCTO/SERVICIO y el usuario solo quiere verlo, deja "detalle" vacío y se enviarán todas sus fotos; si pide algo concreto (p. ej. "el baño", "vista de noche"), ponlo en "detalle" y se enviará la foto que mejor coincida.\n${lines.join('\n')}`,
      parameters: {
        type: 'object',
        properties: {
          recurso: { type: 'string', description: 'Producto/servicio o recurso a enviar (lo más parecido de la lista).' },
          detalle: { type: 'string', description: 'Opcional: aspecto/foto concreta que pide el usuario dentro de ese producto.' },
          mensaje: { type: 'string', description: 'Texto opcional para acompañar el/los archivo(s).' },
        },
        required: ['recurso'],
      },
    },
  }
}
async function sendOneAsset(ctx, a, caption) {
  const url = `${resourceBaseUrl()}/api/media/${ctx.accId}/${a.mediaId}/raw`
  const kind = ['image', 'video', 'audio'].includes(a.kind) ? a.kind : 'file'
  await sendBotMsg(ctx, caption || '', { media: { kind, url, filename: a.filename }, mediaUrl: url, kind, filename: a.filename })
}
async function sendCmsResource(ctx, args) {
  const assets = ctx.account?.cmsAssets || []
  const folders = ctx.account?.cmsFolders || []
  if (!assets.length) return 'No hay recursos en la biblioteca del CMS.'
  const recurso = args?.recurso || ''
  const detalle = args?.detalle || ''
  const caption = args?.mensaje || ''
  const recTokens = tokenize(recurso)

  // 1) ¿"recurso" coincide con una carpeta (producto/servicio)?
  const folderScored = folders
    .map(f => ({ f, score: scoreText(recTokens, f.name) + scoreText(recTokens, f.description || ''), items: assets.filter(a => a.folderId === f.id) }))
    .filter(x => x.items.length)
    .sort((a, b) => b.score - a.score)
  const topFolder = folderScored[0]
  if (topFolder && topFolder.score >= 2) {
    const { f, items } = topFolder
    if (f.type === 'unit' && !detalle.trim()) {
      // Super unidad sin detalle → enviar todas las fotos del producto/servicio.
      for (let i = 0; i < items.length; i++) await sendOneAsset(ctx, items[i], i === 0 ? caption : '')
      logDebug(ctx, 'tool_result', `📎 Enviadas ${items.length} fotos de "${f.name}"`, {})
      return `Te envié ${items.length} archivo(s) de "${f.name}".`
    }
    // Buscar dentro de la carpeta la foto concreta.
    const q2 = tokenize(`${detalle} ${detalle ? '' : recurso}`)
    const best = pickBest(items, q2.length ? q2 : recTokens)
    if (best.asset && best.score >= 1) { await sendOneAsset(ctx, best.asset, caption); return `Envié "${best.asset.name}" de "${f.name}".` }
    const approx = best.asset || items[0]
    await sendOneAsset(ctx, approx, '')
    return `No tengo exactamente lo que buscas dentro de "${f.name}". Te envío lo más aproximado: "${approx.name}".`
  }

  // 2) Buscar entre todos los recursos (nombre, descripción, etiquetas, categoría).
  const queryTokens = [...recTokens, ...tokenize(detalle)]
  const best = pickBest(assets, queryTokens)
  if (best.asset && best.score >= 2) {
    await sendOneAsset(ctx, best.asset, caption)
    logDebug(ctx, 'tool_result', `📎 Recurso enviado: ${best.asset.name}`, { score: best.score })
    return `Recurso "${best.asset.name}" enviado al usuario.`
  }
  // 3) Sin coincidencia clara → enviar lo más aproximado + aviso (condición pedida).
  if (best.asset) {
    await sendOneAsset(ctx, best.asset, '')
    return `No encontré exactamente lo que buscas (o no lo entendí del todo). Te muestro lo más aproximado: "${best.asset.name}". Si no es lo que querías, descríbemelo de otra forma.`
  }
  return `No encontré ningún recurso parecido a "${recurso}".`
}

// Carga los turnos recientes para dar MEMORIA al agente. Descarta el/los turnos
// finales del usuario porque el nodo aporta su propio "mensaje actual".
async function loadHistory(ctx, limit = 16) {
  try {
    const convos = await store.readConvos(ctx.accId, ctx.agId)
    const conv = (convos || []).find(c => c.id === ctx.convId)
    const msgs = (conv?.messages || [])
      .filter(m => typeof m.content === 'string' && m.content.trim())
      .map(m => ({
        role: (m.sender === 'user' || m.role === 'user') ? 'user' : 'assistant',
        content: String(m.content),
      }))
    while (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop()
    return msgs.slice(-limit)
  } catch { return [] }
}

async function callAI(ctx, { systemPrompt, userPrompt, model, provider, maxTokens = 800, temperature = 0.5, jsonMode = false, history = [], tools = [], onToolCall, onTools, onResolved }) {
  const prov = provider || detectProvider(model || 'gpt-4o-mini')
  const finalModel = model || DEFAULT_MODEL[prov] || 'gpt-4o-mini'
  const apiKey = getApiKey(ctx.account, prov)
  if (typeof onResolved === 'function') {
    onResolved({ provider: prov, model: finalModel, keySource: apiKey ? 'account' : 'none' })
  }
  if (!apiKey) throw new Error(`Sin API Key para ${prov}`)

  const onUsage = (u) => {
    try {
      store.recordTokenUsage(ctx.accId, {
        agentId: ctx.agId, conversationId: ctx.convId,
        provider: prov, model: finalModel,
        promptTokens: u?.promptTokens, completionTokens: u?.completionTokens,
        source: 'flow',
      })
    } catch {}
  }

  const messages = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  for (const h of history) {
    if (h?.content) messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content) })
  }
  messages.push({ role: 'user', content: userPrompt })

  // ── Con herramientas → UNA sola ronda; si hay tool call, parar sin texto ──
  if (tools.length > 0) {
    const result = await chat({ provider: prov, model: finalModel, apiKey, messages, tools, maxTokens, temperature, onUsage })
    if (typeof result === 'string') {
      if (typeof onTools === 'function') onTools({ invoked: false, names: [] })
      return result
    }
    const message = result?.message
    const toolCalls = message?.tool_calls || []
    if (toolCalls.length > 0) {
      const executed = []
      for (const tc of toolCalls) {
        let args = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch {}
        const name = tc.function?.name
        logDebug(ctx, 'tool_call', `🔧 Herramienta: ${name}`, args)
        const r = onToolCall ? await onToolCall(name, args) : 'OK'
        logDebug(ctx, 'tool_result', `✅ Resultado: ${name}`, r)
        executed.push(name)
      }
      if (typeof onTools === 'function') onTools({ invoked: true, names: executed })
      return ''
    }
    if (typeof onTools === 'function') onTools({ invoked: false, names: [] })
    return (typeof message?.content === 'string' ? message.content : '') || ''
  }

  // ── Sin herramientas → completion simple ─────────────────────────────────
  const response = await chat({
    provider: prov, model: finalModel, apiKey, messages,
    maxTokens, temperature,
    advanced: jsonMode ? { responseFormat: { type: 'json_object' } } : {},
    onUsage,
  })
  return response || ''
}

const aiNodes = [
  {
    type: 'ai_agent', category: 'ai', label: 'Agente IA',
    async exec(node, ctx) {
      const mode = node.data?.promptMode || 'inline'
      let systemPrompt = ''
      let model = node.data?.modelo || 'gpt-4o-mini'
      let provider
      let temperature = Number(node.data?.temperatura ?? 0.5)
      let promptLabel = 'inline'
      let assignedTools = []

      if (mode === 'active' || mode === 'from_list') {
        const allPrompts = ctx.account?.agents?.flatMap(a => a.prompts || []) || []
        const chosen = mode === 'active'
          ? allPrompts.find(p => p.isActive)
          : allPrompts.find(p => p.id === node.data?.promptId)
        if (!chosen) {
          const msg = mode === 'active'
            ? 'Agente IA: no hay ningún prompt marcado como activo en el agente.'
            : `Agente IA: el prompt seleccionado (${node.data?.promptId || '—'}) ya no existe.`
          logDebug(ctx, 'error', `⚠ ${msg}`, { mode })
          throw new Error(msg)
        }
        systemPrompt = chosen.content || ''
        provider = chosen.provider || undefined
        model    = chosen.model || undefined
        const t = chosen.advanced?.temperature ?? chosen.temperature
        if (t != null) temperature = Number(t)
        promptLabel = chosen.name || '(sin nombre)'
        const toolIds = chosen.toolIds || []
        assignedTools = (ctx.account?.aiTools || []).filter(t => toolIds.includes(t.id))
      } else {
        systemPrompt = interpolate(node.data?.prompt || '', ctx.variables)
      }

      const objetivo = interpolate(node.data?.objetivo || '', ctx.variables)
      const sys = [systemPrompt, objetivo && `OBJETIVO: ${objetivo}`].filter(Boolean).join('\n\n')

      const fallbackMsg = ctx.variables?._lastUserMessage || ctx.variables?.message || ''
      let userMsg = fallbackMsg
      const rawField = node.data?.mensajeUsuario
      if (rawField !== undefined && rawField !== '') {
        const interpolated = interpolate(rawField, ctx.variables)
        userMsg = (interpolated && !/^\{\{.*\}\}$/.test(interpolated.trim())) ? interpolated : fallbackMsg
      }

      const history = await loadHistory(ctx)
      const toolDefs = buildToolDefs(assignedTools, ctx.account)

      let resolved = null
      let toolsInvoked = false
      const reply = await callAI(ctx, {
        systemPrompt: sys,
        userPrompt: userMsg || '(sin contexto del usuario, responde con un saludo)',
        model, provider, history, tools: toolDefs,
        onToolCall: (name, args) => execToolCall(ctx, assignedTools, name, args),
        onTools: info => { toolsInvoked = info.invoked },
        maxTokens: 800, temperature,
        onResolved: r => { resolved = r },
      })

      logDebug(ctx, 'flow_run',
        `🤖 Agente IA · ${resolved?.provider || provider || '?'} · ${resolved?.model || model || '?'}`,
        { promptMode: mode, prompt: promptLabel, temperature, turnosDeHistorial: history.length,
          herramientas: assignedTools.map(t => t.name), herramientaActivada: toolsInvoked,
          mensajeUsuario: (userMsg || '').slice(0, 200) })

      if (toolsInvoked) {
        logDebug(ctx, 'flow_run', '⛔ Herramienta IA activada → sin respuesta del asistente y el flujo se detiene', {})
        ctx._suppressDefaultNext = true
        return
      }

      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, reply)
      if (node.data?.sendToUser !== false && reply) await sendBotMsg(ctx, reply)
    },
  },
  {
    type: 'ai_chat', category: 'ai', label: 'Chat IA',
    async exec(node, ctx) {
      const sys = interpolate(node.data?.prompt || '', ctx.variables)
      const history = await loadHistory(ctx)
      const reply = await callAI(ctx, {
        systemPrompt: sys, userPrompt: ctx.variables?._lastUserMessage || '',
        model: node.data?.modelo, maxTokens: 600, history,
      })
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, reply)
      else if (reply) await sendBotMsg(ctx, reply)
    },
  },
  {
    type: 'intent_classifier', category: 'ai', label: 'Clasificador de intención',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '{{_lastUserMessage}}', ctx.variables)
      const intents = String(node.data?.intents || '').split(',').map(s => s.trim()).filter(Boolean)
      if (!txt || !intents.length) throw new Error('Falta texto o intents')
      const sys = `Eres un clasificador. Dado el texto, elige UNA intent de la lista: ${intents.join(', ')}.
Responde SOLO JSON: {"intent":"<una de la lista>","confidence":0.0-1.0}`
      const raw = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 100, temperature: 0, jsonMode: true })
      let parsed = { intent: intents[0], confidence: 0 }
      try { parsed = JSON.parse(raw) } catch {}
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, parsed.intent)
      ctx.variables._last_intent = parsed.intent
      ctx.variables._last_intent_confidence = parsed.confidence
      logDebug(ctx, 'flow_run', `🎯 Intent: ${parsed.intent} (${(parsed.confidence * 100).toFixed(0)}%)`, parsed)
    },
  },
  {
    type: 'entity_extractor', category: 'ai', label: 'Extractor de entidades',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const entities = String(node.data?.entidades || '').split(',').map(s => s.trim()).filter(Boolean)
      const sys = `Extrae las siguientes entidades del texto. Devuelve SOLO JSON con esas claves; valor null si no aparece. Claves: ${entities.join(', ')}.`
      const raw = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 300, temperature: 0, jsonMode: true })
      let parsed = {}
      try { parsed = JSON.parse(raw) } catch {}
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, JSON.stringify(parsed))
      for (const [k, v] of Object.entries(parsed)) { if (v != null) ctx.variables[`entity_${k}`] = v }
      logDebug(ctx, 'flow_run', '🧩 Entidades extraídas', parsed)
    },
  },
  {
    type: 'sentiment_analyzer', category: 'ai', label: 'Sentimiento',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const sys = 'Clasifica el sentimiento del texto. Devuelve SOLO JSON: {"sentiment":"positive|neutral|negative","score":-1.0 a 1.0}'
      const raw = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 80, temperature: 0, jsonMode: true })
      let parsed = { sentiment: 'neutral', score: 0 }
      try { parsed = JSON.parse(raw) } catch {}
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, parsed.sentiment)
      ctx.variables._last_sentiment = parsed.sentiment
      ctx.variables._last_sentiment_score = parsed.score
    },
  },
  {
    type: 'summarizer', category: 'ai', label: 'Resumidor',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const longitud = node.data?.longitud || 'mediano'
      const sys = `Resume el texto en español. Formato: ${longitud}.`
      const summary = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 400 })
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, summary)
      else await sendBotMsg(ctx, summary)
    },
  },
  {
    type: 'rewriter', category: 'ai', label: 'Reescritor',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const tono = node.data?.tono || 'informal'
      const sys = `Reescribe el siguiente texto con tono ${tono}. Mantén el sentido. Devuelve SOLO el texto reescrito.`
      const out = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 400 })
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, out)
      else await sendBotMsg(ctx, out)
    },
  },
  {
    type: 'ai_router', category: 'ai', label: 'Router IA',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const rutas = String(node.data?.rutas || '').split(',').map(s => s.trim()).filter(Boolean)
      if (!rutas.length) throw new Error('Define al menos una ruta')
      const sys = `Eres un router. Elige UNA de estas rutas: ${rutas.join(', ')}.\nResponde SOLO el nombre exacto.`
      const choice = (await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 16, temperature: 0 })).trim().toLowerCase()
      const winner = rutas.find(r => r.toLowerCase() === choice) || rutas[0]
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, winner)
      ctx.variables._last_route = winner
      logDebug(ctx, 'flow_run', `🛤 Router IA → ${winner}`, { rutas })
    },
  },
]

module.exports = { aiNodes }
