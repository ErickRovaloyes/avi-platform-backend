'use strict'
/**
 * Aprovisionamiento del "agente IA de inicio" al CREAR una cuenta (super panel o Demo).
 * Deja la cuenta lista para chatear por WEBCHAT con un agente IA, sin configuración manual:
 *   1) variable local {{respuesta_ia}},
 *   2) flujo "transferir_a_asesor" (nodo de transferencia a asesor humano),
 *   3) herramienta IA "transferir_a_asesor" que ejecuta ese flujo,
 *   4) flujo "Generador de respuestas Agente IA" (ai_agent → message) = flujo de entrada,
 *   5) agente deepseek-v4-flash con el prompt ACTIVO (max_tokens 600, temp 0.1, con la
 *      herramienta transferir_a_asesor) + un canal webchat de prueba.
 * `provisionStarterAgent` es la fuente única; `provisionDefaultAgent` (super panel) y
 * `provisionDemoAgent` (services/demoProvision.js) la usan.
 */
const pool = require('../db')
const { uid } = require('../utils')
const { generateAccountPrompt } = require('../controllers/promptGenerator.controller')

const clean = s => String(s || '').trim()

// Prompt determinista (sin IA) a partir de la estructura/condiciones del generador
// y la info del formulario. Siempre disponible como red de seguridad.
function buildFallbackPrompt({ agentName, companyName, observations, docText, structure, conditions }) {
  const ia = clean(agentName) || 'Asistente'
  const co = clean(companyName) || 'la empresa'
  const L = []
  L.push('# IDENTIDAD')
  L.push(`Eres ${ia}, el asistente virtual de ${co}. Atiendes en español con un tono profesional, cercano y resolutivo. Sé claro y conciso.`)
  if (clean(observations)) { L.push(''); L.push('# INDICACIONES ESPECÍFICAS'); L.push(clean(observations)) }
  if (clean(structure))    { L.push(''); L.push('# ESTRUCTURA'); L.push(clean(structure)) }
  if (clean(conditions))   { L.push(''); L.push('# CONDICIONES DE CALIDAD'); L.push(clean(conditions)) }
  if (clean(docText))      { L.push(''); L.push('# BASE DE CONOCIMIENTO'); L.push('Usa esta información del negocio como fuente principal de verdad:'); L.push(clean(docText).slice(0, 12000)) }
  L.push(''); L.push('# REGLAS')
  L.push(`- Responde solo sobre ${co} y su oferta; si no sabes algo o el cliente pide hablar con una persona, usa la herramienta "transferir_a_asesor".`)
  L.push('- No inventes precios, políticas ni datos que no tengas.')
  L.push('- Sé breve; evita textos largos salvo que el usuario pida detalle.')
  return L.join('\n')
}

// Nodos del flujo "Generador de respuestas Agente IA". El ai_agent usa el prompt ACTIVO
// del agente (promptMode 'active') → hereda proveedor/modelo/temp/max_tokens/herramientas
// y guarda la respuesta en {{respuesta_ia}}; el nodo message la envía al usuario.
function buildResponseFlowNodes(varId, startNodeId) {
  return [
    {
      id: 'n_msg_out', type: 'message', x: 463, y: 154,
      data: { text: '¡Bienvenido!', mensaje: '{{respuesta_ia}}' },
      connections: { success: null },
    },
    {
      id: startNodeId, type: 'ai_agent', x: 307, y: 150,
      data: {
        modelo: 'deepseek-v4-flash', nombre: 'Asistente', _verbose: true,
        promptMode: 'active', sendToUser: false, temperatura: 0.1,
        mensajeUsuario: '{{_lastUserMessage}} ', variable_destino: varId,
      },
      connections: { error: null, success: 'n_msg_out' },
    },
  ]
}

// Nodo del flujo "transferir_a_asesor": transfiere a un asesor humano con un mensaje
// genérico y apaga la IA en ese chat (disable_ai por defecto).
function buildTransferFlowNodes() {
  const startNodeId = 'n_transfer'
  return {
    startNodeId,
    nodes: [{
      id: startNodeId, type: 'human_transfer', x: 320, y: 150,
      data: { mensaje: 'Perfecto, en un momento te comunico con un asesor humano. 🙌', disable_ai: true },
      connections: { success: null },
    }],
  }
}

// Aprovisiona el "agente IA de inicio" completo. Fuente única (super panel + Demo).
// Devuelve { agentId, flowId, varId, transferFlowId, toolId, webchatId }.
async function provisionStarterAgent(accId, { agentName, prompt } = {}) {
  const name = clean(agentName) || 'Asistente'
  const promptContent = clean(prompt) || buildFallbackPrompt({ agentName: name })

  // 1) Variable local {{respuesta_ia}}.
  const varId = 'var_' + uid()
  await pool.query(
    'INSERT INTO variables (id,account_id,name,type,default_value,description,is_system) VALUES (?,?,?,?,?,?,?)',
    [varId, accId, 'respuesta_ia', 'local', '', 'Respuesta generada por el asistente IA', 0]
  )

  // 2) Flujo "transferir_a_asesor".
  const transferFlowId = 'flow_' + uid()
  const tf = buildTransferFlowNodes()
  await pool.query(
    'INSERT INTO flows (id,account_id,name,`trigger`,start_node_id,nodes,created_at) VALUES (?,?,?,?,?,?,?)',
    [transferFlowId, accId, 'transferir_a_asesor', 'manual', tf.startNodeId, JSON.stringify(tf.nodes), Date.now()]
  )

  // 3) Herramienta IA "transferir_a_asesor" que ejecuta el flujo anterior.
  const toolId = 'tool_' + uid()
  await pool.query(
    'INSERT INTO ai_tools (id,account_id,name,description,collect_fields,flow_id,action_type) VALUES (?,?,?,?,?,?,?)',
    [toolId, accId, 'transferir_a_asesor',
     'Transfiere la conversación a un asesor humano. Úsala cuando el cliente pida hablar con una persona o cuando no puedas resolver su solicitud.',
     '[]', transferFlowId, 'flow']
  )

  // 4) Flujo "Generador de respuestas Agente IA" (ai_agent → message) → flujo de entrada.
  const flowId = 'flow_' + uid()
  const startNodeId = 'n_ai_' + uid()
  const nodes = buildResponseFlowNodes(varId, startNodeId)
  await pool.query(
    'INSERT INTO flows (id,account_id,name,`trigger`,start_node_id,nodes,created_at) VALUES (?,?,?,?,?,?,?)',
    [flowId, accId, 'Generador de respuestas Agente IA', 'manual', startNodeId, JSON.stringify(nodes), Date.now()]
  )

  // 5) Agente deepseek-v4-flash con el prompt ACTIVO (temp 0.1, herramienta
  //    transferir_a_asesor) + canal webchat + flujo Generador como entrada (fallback).
  //    maxTokens 4096 = mismo techo que un prompt creado a mano en la UI. Es un TECHO:
  //    no encarece salvo que se use, y evita que las respuestas lleguen cortadas.
  const agentId = 'ag_' + uid()
  const webchatId = 'lnk_' + uid()
  const prompts = [{
    id: 'pr_' + uid(), name: 'Prompt principal', content: promptContent, isActive: true,
    provider: 'deepseek', model: 'deepseek-v4-flash',
    advanced: { maxTokens: 4096, temperature: 0.1 }, toolIds: [toolId],
  }]
  const channels = [{ id: webchatId, type: 'webchat', name: 'Webchat', status: 'active', config: {}, createdAt: Date.now() }]
  await pool.query(
    'INSERT INTO agents (id,account_id,name,status,system_prompt,model,welcome_message,prompts,channels,rag,ai_tool_ids,fallback_flow_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [agentId, accId, name, 'active', promptContent, 'deepseek-v4-flash',
     `¡Hola! Soy ${name}. ¿En qué puedo ayudarte?`,
     JSON.stringify(prompts), JSON.stringify(channels), JSON.stringify({ enabled: false, files: [] }), JSON.stringify([toolId]), flowId]
  )

  return { agentId, flowId, varId, transferFlowId, toolId, webchatId }
}

// Super panel: genera el prompt (generador IA con fallback) y aprovisiona el starter.
async function provisionDefaultAgent(accId, opts = {}) {
  const companyName  = clean(opts.companyName)
  const agentName    = clean(opts.agentName) || companyName || 'Asistente'
  const observations = clean(opts.observations)
  const docText      = opts.docText || ''

  let structure = '', conditions = ''
  try {
    const [[s]] = await pool.query('SELECT prompt_generator_structure, prompt_generator_conditions FROM platform_settings WHERE id=1')
    structure = s?.prompt_generator_structure || ''
    conditions = s?.prompt_generator_conditions || ''
  } catch { /* settings opcionales */ }

  let prompt = null
  try { prompt = await generateAccountPrompt({ accountId: accId, agentName, companyName, observations, docText }) } catch { prompt = null }
  if (!prompt) prompt = buildFallbackPrompt({ agentName, companyName, observations, docText, structure, conditions })

  return provisionStarterAgent(accId, { agentName, prompt })
}

module.exports = { provisionStarterAgent, provisionDefaultAgent, buildFallbackPrompt, buildResponseFlowNodes, buildTransferFlowNodes }
