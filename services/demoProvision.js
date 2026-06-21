'use strict'
/**
 * Aprovisionamiento de la cuenta Demo inteligente.
 * A partir de los datos del onboarding:
 *   1) genera un PROMPT MAESTRO personalizado (IA con la key de plataforma; si no
 *      hay key o falla, usa un ensamblado determinista),
 *   2) crea el agente con ese prompt activo,
 *   3) crea un flujo de respuesta (Agente IA · prompt activo) y lo deja como flujo
 *      de entrada,
 *   4) crea y activa un canal Webchat listo para probar.
 * Devuelve { agentId, webchatLink, iaName }.
 */
const pool = require('../db')
const { uid } = require('../utils')
const { chat } = require('./aiClient')

const clean = s => String(s || '').trim()

// Ensamblado determinista (siempre funciona, sin depender de la IA).
function buildMasterPrompt(d) {
  const L = []
  const ia = clean(d.iaName) || 'Asistente'
  L.push(`# IDENTIDAD`)
  L.push(`Eres ${ia}, el asistente virtual de ${clean(d.company) || 'la empresa'}${d.industry ? ` (sector: ${clean(d.industry)})` : ''}.`)
  if (d.objective) L.push(`Tu objetivo principal es: ${clean(d.objective)}.`)
  L.push(`Atiendes en español, con un tono profesional, cercano y resolutivo. Sé claro y conciso.`)
  L.push('')
  L.push(`# LA EMPRESA`)
  if (d.whatCompanyDoes) L.push(`Qué hace: ${clean(d.whatCompanyDoes)}`)
  if (d.products)       L.push(`Productos: ${clean(d.products)}`)
  if (d.services)       L.push(`Servicios: ${clean(d.services)}`)
  if (d.differentiator) L.push(`Diferenciador: ${clean(d.differentiator)}`)
  if (d.website)        L.push(`Sitio web: ${clean(d.website)}`)
  L.push('')
  L.push(`# CLIENTES`)
  if (d.idealClient) L.push(`Cliente ideal: ${clean(d.idealClient)}`)
  if (d.faqs)        L.push(`Preguntas frecuentes a resolver:\n${clean(d.faqs)}`)
  if (d.objections)  L.push(`Objeciones comunes y cómo rebatirlas: ${clean(d.objections)}`)
  L.push('')
  L.push(`# PROCESO COMERCIAL`)
  if (d.salesProcess)     L.push(`Cómo funciona la venta: ${clean(d.salesProcess)}`)
  if (d.infoBeforeBuying) L.push(`Información que pides antes de cerrar: ${clean(d.infoBeforeBuying)}`)
  L.push('')
  L.push(`# ATENCIÓN`)
  if (d.hours)           L.push(`Horarios: ${clean(d.hours)}`)
  if (d.coverage)        L.push(`Cobertura geográfica: ${clean(d.coverage)}`)
  if (d.contactChannels) L.push(`Canales de contacto: ${clean(d.contactChannels)}`)
  L.push('')
  L.push(`# REGLAS`)
  L.push(`- Responde SOLO sobre ${clean(d.company) || 'la empresa'} y su oferta. Si no sabes algo, ofrécete a tomar los datos para que un asesor humano contacte.`)
  L.push(`- Guía siempre la conversación hacia el objetivo (${clean(d.objective) || 'ayudar y convertir'}).`)
  L.push(`- No inventes precios, políticas ni datos que no se te hayan dado.`)
  L.push(`- Sé breve; evita textos largos salvo que el usuario pida detalle.`)
  return L.join('\n')
}

async function platformOpenaiKey() {
  try { const [[r]] = await pool.query('SELECT openai_key FROM platform_settings WHERE id=1'); return r?.openai_key || '' }
  catch { return '' }
}

// Genera el prompt maestro con IA (si hay key de plataforma); si falla → determinista.
async function generateMasterPrompt(d) {
  const fallback = buildMasterPrompt(d)
  const apiKey = await platformOpenaiKey()
  if (!apiKey) return fallback
  try {
    const sys = `Eres un PROMPT ENGINEER SENIOR. Genera un SYSTEM PROMPT en español, profesional, detallado y accionable, para un asistente IA de atención/ventas de una empresa, a partir de los datos estructurados del negocio que te paso. Incluye: identidad y tono, descripción de la empresa, productos/servicios, cliente ideal, FAQs, manejo de objeciones, proceso comercial, atención (horarios/cobertura), objetivo de conversión y reglas (no inventar precios/políticas, derivar a humano si no sabe). Devuelve SOLO el prompt, sin comentarios.`
    const user = `Datos del negocio (JSON):\n${JSON.stringify(d, null, 2)}`
    const out = await chat({
      provider: 'openai', model: 'gpt-4o-mini', apiKey,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      maxTokens: 1800, temperature: 0.5,
    })
    const text = typeof out === 'string' ? out.trim() : ''
    return text && text.length > 120 ? text : fallback
  } catch { return fallback }
}

// Crea agente + flujo de respuesta + canal Webchat activo. Devuelve ids.
async function provisionDemoAgent(accId, d) {
  const iaName = clean(d.iaName) || 'Asistente'
  const masterPrompt = await generateMasterPrompt(d)

  // 1) Flujo de respuesta: Agente IA usando el prompt activo del agente.
  const flowId = 'flow_' + uid()
  const startNode = 'n_ai_' + uid()
  const nodes = [{
    id: startNode, type: 'ai_agent', x: 140, y: 100,
    data: { promptMode: 'active', mensajeUsuario: '{{_lastUserMessage}}', sendToUser: true },
    connections: [],
  }]
  await pool.query(
    'INSERT INTO flows (id,account_id,name,`trigger`,start_node_id,nodes,created_at) VALUES (?,?,?,?,?,?,?)',
    [flowId, accId, 'Respuesta IA', 'conversation_start', startNode, JSON.stringify(nodes), Date.now()]
  )

  // 2) Agente con el prompt maestro activo + canal Webchat activo.
  const agentId = 'ag_' + uid()
  const webchatId = 'lnk_' + uid()
  const prompts = [{
    id: 'pr_' + uid(), name: `Prompt Maestro · ${iaName}`,
    content: masterPrompt, isActive: true, provider: 'openai', model: 'gpt-4o-mini',
  }]
  const channels = [{ id: webchatId, type: 'webchat', name: 'Webchat', status: 'active', config: {}, createdAt: Date.now() }]
  await pool.query(
    'INSERT INTO agents (id,account_id,name,status,system_prompt,model,welcome_message,prompts,channels,rag,ai_tool_ids,fallback_flow_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [agentId, accId, iaName, 'active', '', 'gpt-4o-mini',
     `¡Hola! Soy ${iaName}. ¿En qué puedo ayudarte?`,
     JSON.stringify(prompts), JSON.stringify(channels), JSON.stringify({ enabled: false, files: [] }), '[]', flowId]
  )
  return { agentId, webchatLink: webchatId, iaName }
}

module.exports = { buildMasterPrompt, generateMasterPrompt, provisionDemoAgent }
