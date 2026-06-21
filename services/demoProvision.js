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

// Recorta el texto de la plantilla para no inflar el prompt (≈ 16k chars).
const DISCOVERY_MAX = 16000
const trimDiscovery = t => { const s = String(t || '').trim(); return s.length > DISCOVERY_MAX ? s.slice(0, DISCOVERY_MAX) : s }

// Ensamblado determinista (siempre funciona, sin depender de la IA).
function buildMasterPrompt(d, discoveryText = '') {
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
  const disc = trimDiscovery(discoveryText)
  if (disc) {
    L.push('')
    L.push(`# BASE DE CONOCIMIENTO (documento de descubrimiento)`)
    L.push(`Usa esta información del negocio como fuente principal de verdad:`)
    L.push(disc)
  }
  return L.join('\n')
}

async function platformOpenaiKey() {
  try { const [[r]] = await pool.query('SELECT openai_key FROM platform_settings WHERE id=1'); return r?.openai_key || '' }
  catch { return '' }
}

// Genera el prompt maestro con IA (si hay key de plataforma); si falla → determinista.
async function generateMasterPrompt(d, discoveryText = '') {
  const fallback = buildMasterPrompt(d, discoveryText)
  const apiKey = await platformOpenaiKey()
  if (!apiKey) return fallback
  try {
    const sys = `Eres un PROMPT ENGINEER SENIOR. Genera un SYSTEM PROMPT en español, profesional, detallado y accionable, para un asistente IA de atención/ventas de una empresa, a partir de los datos estructurados del negocio y del documento de descubrimiento que te paso. Incluye: identidad y tono, descripción de la empresa, productos/servicios, cliente ideal, FAQs, manejo de objeciones, proceso comercial, atención (horarios/cobertura), objetivo de conversión, una sección de BASE DE CONOCIMIENTO con los datos concretos del negocio (extraídos del documento) y reglas (no inventar precios/políticas, derivar a humano si no sabe). Devuelve SOLO el prompt, sin comentarios.`
    const disc = trimDiscovery(discoveryText)
    const user = `Datos del negocio (JSON):\n${JSON.stringify(d, null, 2)}` +
      (disc ? `\n\nDOCUMENTO DE DESCUBRIMIENTO (texto del archivo que subió el cliente):\n"""\n${disc}\n"""` : '')
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
async function provisionDemoAgent(accId, d, discoveryText = '') {
  const iaName = clean(d.iaName) || 'Asistente'
  const masterPrompt = await generateMasterPrompt(d, discoveryText)

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
  return { agentId, webchatLink: webchatId, iaName, masterPrompt }
}

// ── Conversaciones de demostración (efecto "wow" en el inbox) ──────────────────
const SAMPLE_SCENARIOS = [
  'Solicitud de información', 'Consulta de precios', 'Pregunta frecuente',
  'Objeción de venta', 'Caso de soporte', 'Cierre comercial',
]

function buildSampleConversationsFallback(d) {
  const ia = clean(d.iaName) || 'Asistente'
  const co = clean(d.company) || 'la empresa'
  return [
    { scenario: 'Solicitud de información', guestName: 'Cliente · Información', messages: [
      { role: 'user', text: `Hola, ¿qué ofrece ${co}?` },
      { role: 'assistant', text: `¡Hola! Soy ${ia}. En ${co} ${clean(d.whatCompanyDoes) || 'ayudamos a nuestros clientes con soluciones a su medida'}. ¿Te cuento más sobre algún producto o servicio en particular?` },
    ] },
    { scenario: 'Consulta de precios', guestName: 'Cliente · Precios', messages: [
      { role: 'user', text: '¿Cuánto cuesta?' },
      { role: 'assistant', text: `Con gusto. Para darte un precio exacto necesito un par de datos sobre lo que buscas. ¿Me cuentas qué necesitas y para cuándo? Así te preparo una propuesta de ${co}.` },
    ] },
    { scenario: 'Objeción de venta', guestName: 'Cliente · Objeción', messages: [
      { role: 'user', text: 'Lo vi más barato en otro lado.' },
      { role: 'assistant', text: `Entiendo. Lo que nos diferencia es ${clean(d.differentiator) || 'la calidad y el acompañamiento'}. Muchos clientes eligen ${co} justo por eso. ¿Quieres que comparemos lo que incluye cada opción?` },
    ] },
  ]
}

async function generateSampleConversations(accId, agentId, d, masterPrompt) {
  let convos = null
  const apiKey = await platformOpenaiKey()
  if (apiKey) {
    try {
      const sys = `Genera CONVERSACIONES de ejemplo (en español) entre un cliente y el asistente "${clean(d.iaName) || 'Asistente'}" de la empresa "${clean(d.company) || ''}", para mostrarlas como demo. Cada conversación: 2 a 4 turnos, realista, y el asistente DEBE responder usando la información del negocio. Cubre estos escenarios: ${SAMPLE_SCENARIOS.join(', ')}. Devuelve SOLO un array JSON: [{"scenario":"...","guestName":"Cliente · ...","messages":[{"role":"user","text":"..."},{"role":"assistant","text":"..."}]}]`
      const user = `Contexto del negocio:\n${(masterPrompt || '').slice(0, 6000)}`
      const out = await chat({ provider: 'openai', model: 'gpt-4o-mini', apiKey, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens: 1800, temperature: 0.6 })
      const text = typeof out === 'string' ? out : ''
      const m = text.match(/\[[\s\S]*\]/)
      if (m) convos = JSON.parse(m[0])
    } catch { convos = null }
  }
  if (!Array.isArray(convos) || !convos.length) convos = buildSampleConversationsFallback(d)

  const socket = require('./socket')
  let n = 0
  for (const c of convos.slice(0, 6)) {
    if (!Array.isArray(c?.messages) || !c.messages.length) continue
    const convId = `conv_webchat_${Date.now()}_${++n}`
    const guest = clean(c.guestName) || `Ejemplo ${n}`
    const last = c.messages[c.messages.length - 1]?.text || ''
    const ts = Date.now() - (convos.length - n) * 60000
    await pool.query(
      `INSERT INTO conversations (id,account_id,agent_id,channel_id,channel_type,guest_name,guest_id,initials,preview,unread,ai_enabled,labels,pipeline_cards,local_vars,debug_log,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [convId, accId, agentId, 'webchat', 'webchat', `🧪 ${guest}`, String(1000 + n), (guest || '').slice(0, 2).toUpperCase(),
       last.slice(0, 60), 0, 1, '[]', '[]', JSON.stringify({ _sample: true }), '[]', ts, ts]
    )
    let mi = 0
    for (const msg of c.messages) {
      const sender = msg.role === 'assistant' ? 'ai' : 'user'
      await pool.query('INSERT INTO messages (id,conversation_id,sender,content,metadata,ts) VALUES (?,?,?,?,?,?)',
        [`msg_${Date.now()}_${n}_${mi}`, convId, sender, String(msg.text || ''), JSON.stringify({ sample: true }), ts + (mi++ * 1000)])
    }
  }
  try { socket.emit(accId, 'convos:updated', { accId, agId: agentId }) } catch {}
  return n
}

module.exports = { buildMasterPrompt, generateMasterPrompt, provisionDemoAgent, generateSampleConversations }
