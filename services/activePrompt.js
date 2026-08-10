'use strict'
/**
 * Resuelve el PROMPT ACTIVO de un agente para los mensajes que la plataforma envía por su
 * cuenta: recontactos, recordatorios de reserva y avisos de pedido.
 *
 * El problema que resuelve
 * ------------------------
 * Cada uno de esos servicios se inventaba su propio mensaje de sistema («Eres un asistente
 * de atención al cliente…»), su propio modelo (`gpt-4o-mini` fijo) y su propio techo de
 * tokens (160/200/220). Consecuencias, las dos reportadas por el usuario:
 *
 *   1. Los mensajes salían CORTADOS, porque 160 tokens no dan para más.
 *   2. No sonaban al agente: ese mensaje de sistema sustituía —o recortaba a 1.000
 *      caracteres— el prompt configurado, con lo que se perdían el tono y las reglas
 *      del negocio.
 *
 * Aquí el prompt del agente se usa ENTERO y tal cual, igual que hace el nodo Agente IA en
 * modo «prompt activo» (flow/nodes/ai.js). La instrucción concreta del momento («el cliente
 * dejó de responder, retoma la conversación») NO va como personalidad: va como contexto del
 * turno, que es su sitio.
 */
const { parseJ } = require('../utils')

/**
 * @param {object} account  Cuenta ya cargada (store.loadAccount)
 * @param {string} agId     Agente; si no se pasa o no existe, se usa el primero
 * @returns {{agent, prompt, systemPrompt, provider, model, temperature, maxTokens, advanced}|null}
 */
function resolveActivePrompt(account, agId) {
  const agents = account?.agents || []
  const agent = (agId && agents.find(a => a.id === agId)) || agents[0]
  if (!agent) return null

  const prompts = agent.prompts || []
  const prompt = prompts.find(p => p?.isActive) || prompts[0] || null

  // `advanced` puede venir serializado según de dónde salga la cuenta.
  const advanced = (prompt && (typeof prompt.advanced === 'string' ? parseJ(prompt.advanced, {}) : prompt.advanced)) || {}

  // El modelo del prompt manda; si no fija ninguno, el de la plataforma (que es el que
  // gobierna aiModelPolicy según Google). Nunca se cae a un modelo escrito a mano aquí:
  // eso es justo lo que dejaba `gpt-4o-mini` colado en producción.
  const model = prompt?.model || account?.defaultPromptModel || ''
  let provider = prompt?.provider || (model && model === account?.defaultPromptModel ? account?.defaultPromptProvider : '') || ''
  if (!provider && model) {
    try { provider = require('../controllers/promptGenerator.controller').detectProvider(model) } catch { provider = '' }
  }

  const temperature = advanced.temperature ?? prompt?.temperature
  const maxTokens = advanced.maxTokens

  return {
    agent,
    prompt,
    systemPrompt: String(prompt?.content || '').trim(),
    provider: provider || '',
    model: model || '',
    temperature: temperature == null ? undefined : Number(temperature),
    // Sin techo configurado se deja indefinido a propósito: el cliente de IA aplica su
    // valor por defecto (4096), muy por encima de los 160 que cortaban los mensajes.
    maxTokens: maxTokens == null ? undefined : Number(maxTokens),
    advanced,
  }
}

/**
 * Compone el mensaje de sistema para un envío automático.
 *
 * El prompt del agente va PRIMERO y entero. La instrucción del momento se añade después,
 * marcada como encargo puntual, para que module la respuesta sin suplantar la identidad.
 * Si el agente no tiene prompt, se cae a la instrucción sola: es mejor que no enviar nada.
 */
function composeSystem(systemPrompt, instruction) {
  const base = String(systemPrompt || '').trim()
  const enc = String(instruction || '').trim()
  if (!base) return enc
  if (!enc) return base
  return `${base}\n\n---\nENCARGO DE ESTE MENSAJE (no lo menciones al cliente): ${enc}`
}

module.exports = { resolveActivePrompt, composeSystem }
