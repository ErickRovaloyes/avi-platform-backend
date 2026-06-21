'use strict'
/**
 * Aprovisionamiento por defecto al CREAR una cuenta (super admin).
 * Deja la cuenta lista para operar:
 *   1) genera el PROMPT del agente con el GENERADOR DE PROMPTS de la plataforma
 *      (estructura + condiciones de calidad de Super Admin → Plataforma) usando
 *      la info del formulario y el documento subido; si no hay key/falla, usa un
 *      ensamblado determinista,
 *   2) crea la variable {{respuesta_ia}},
 *   3) crea el flujo "Generar respuesta con asistente IA" (provisto) y lo deja
 *      como flujo de respuesta (fallback) del agente,
 *   4) crea el agente con ese prompt ACTIVO en DeepSeek V4 Flash.
 * Devuelve { agentId, flowId, varId }.
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
  L.push(`- Responde solo sobre ${co} y su oferta; si no sabes algo, ofrécete a tomar los datos para que un asesor humano contacte.`)
  L.push('- No inventes precios, políticas ni datos que no tengas.')
  L.push('- Sé breve; evita textos largos salvo que el usuario pida detalle.')
  return L.join('\n')
}

// Nodos del flujo "Generar respuesta con asistente IA" (provistos por el cliente).
// El ai_agent usa el prompt ACTIVO del agente (promptMode 'active') → hereda
// proveedor/modelo (DeepSeek V4 Flash) y guarda la respuesta en {{respuesta_ia}};
// el nodo message la envía al usuario. `variable_destino` apunta a la variable
// recién creada (cuyo NOMBRE es respuesta_ia → así {{respuesta_ia}} resuelve).
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
        modelo: 'gpt-4o-mini', nombre: 'Asistente', _verbose: true,
        promptMode: 'active', sendToUser: false, temperatura: 0.5,
        mensajeUsuario: '{{_lastUserMessage}} ', variable_destino: varId,
      },
      connections: { error: null, success: 'n_msg_out' },
    },
  ]
}

async function provisionDefaultAgent(accId, opts = {}) {
  const companyName  = clean(opts.companyName)
  const agentName    = clean(opts.agentName) || companyName || 'Asistente'
  const observations = clean(opts.observations)
  const docText      = opts.docText || ''

  // 1) Prompt: generador IA (estructura + condiciones + form + doc) con fallback.
  let structure = '', conditions = ''
  try {
    const [[s]] = await pool.query('SELECT prompt_generator_structure, prompt_generator_conditions FROM platform_settings WHERE id=1')
    structure = s?.prompt_generator_structure || ''
    conditions = s?.prompt_generator_conditions || ''
  } catch { /* settings opcionales */ }

  let prompt = null
  try { prompt = await generateAccountPrompt({ accountId: accId, agentName, companyName, observations, docText }) } catch { prompt = null }
  if (!prompt) prompt = buildFallbackPrompt({ agentName, companyName, observations, docText, structure, conditions })

  // 2) Variable {{respuesta_ia}} (nombre canónico que usa el flujo).
  const varId = 'var_' + uid()
  await pool.query(
    'INSERT INTO variables (id,account_id,name,type,default_value,description,is_system) VALUES (?,?,?,?,?,?,?)',
    [varId, accId, 'respuesta_ia', 'local', '', 'Respuesta generada por el asistente IA', 0]
  )

  // 3) Flujo de respuesta (provisto) → fallback del agente.
  const flowId = 'flow_' + uid()
  const startNodeId = 'n_ai_' + uid()
  const nodes = buildResponseFlowNodes(varId, startNodeId)
  await pool.query(
    'INSERT INTO flows (id,account_id,name,`trigger`,start_node_id,nodes,created_at) VALUES (?,?,?,?,?,?,?)',
    [flowId, accId, 'Generar respuesta con asistente IA', 'manual', startNodeId, JSON.stringify(nodes), Date.now()]
  )

  // 4) Agente con el prompt ACTIVO en DeepSeek V4 Flash + flujo como fallback.
  const agentId = 'ag_' + uid()
  const prompts = [{
    id: 'pr_' + uid(), name: 'Prompt principal', content: prompt,
    isActive: true, provider: 'deepseek', model: 'deepseek-v4-flash',
  }]
  await pool.query(
    'INSERT INTO agents (id,account_id,name,status,system_prompt,model,welcome_message,prompts,channels,rag,ai_tool_ids,fallback_flow_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [agentId, accId, agentName, 'active', prompt, 'deepseek-v4-flash',
     `¡Hola! Soy ${agentName}. ¿En qué puedo ayudarte?`,
     JSON.stringify(prompts), '[]', JSON.stringify({ enabled: false, files: [] }), '[]', flowId]
  )

  return { agentId, flowId, varId }
}

module.exports = { provisionDefaultAgent, buildFallbackPrompt, buildResponseFlowNodes }
