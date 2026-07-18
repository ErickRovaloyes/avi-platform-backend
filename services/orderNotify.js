'use strict'
/**
 * Notificaciones de EVENTOS del pedido (tienda) en la conversación del cliente.
 * Cada evento (created / paid / status) puede enviarse de 4 formas configurables:
 *   - default : mensaje integrado de la plataforma
 *   - ia      : lo redacta la IA con el prompt activo del agente
 *   - flow    : ejecuta un flujo (que lleva su propio mensaje personalizado dentro)
 *   - off     : no envía nada
 * Reutiliza el patrón de recontact.js (IA + prompt activo) y calendarNotify (outbound).
 */
const pool = require('../db')
const store = require('./store')
const flowStore = require('../flow/store')
const { sendBotMsg } = require('../flow/common')
const { buildOutbound } = require('./calendarNotify')
const { executeFlow } = require('../flow/engine')
const { callAI, detectProvider, resolveProviderKey } = require('../controllers/promptGenerator.controller')

const EXTERNAL = new Set(['whatsapp', 'messenger', 'instagram'])
const STATUS_ES = {
  pending: 'pendiente de pago', processing: 'en preparación', 'on-hold': 'en espera',
  completed: 'completado / entregado', cancelled: 'cancelado', refunded: 'reembolsado',
  failed: 'fallido', shipped: 'enviado', paid: 'pagado', open: 'abierto',
}
const statusEs = s => STATUS_ES[String(s || '').toLowerCase()] || s || ''

// Mensaje integrado (modo default) por evento.
function defaultMessage(event, v) {
  if (event === 'created') return `🛒 Pedido creado${v.pedido_items ? `: ${v.pedido_items}` : ''}${v.total ? `\nTotal: ${v.total} ${v.currency}` : ''}\n\n💳 Paga aquí:\n${v.pay_url}\n\nApenas completes el pago te confirmo automáticamente.`
  if (event === 'paid') return `✅ ¡Pago confirmado! Recibimos tu pago del pedido #${v.pedido_id}${v.total ? ` por ${v.total} ${v.currency}` : ''}. ¡Gracias por tu compra! 🎉`
  if (event === 'status') return `📦 Tu pedido #${v.pedido_id} ahora está: *${statusEs(v.pedido_estado)}*.`
  return ''
}

// Instrucción para la IA (modo ia). Debe incluir el link de pago en "created".
function iaInstruction(event, v) {
  if (event === 'created') return `Avísale al cliente que su pedido quedó CREADO e incluye el link de pago TAL CUAL, sin modificarlo: ${v.pay_url}${v.total ? ` (total ${v.total} ${v.currency})` : ''}. Dile que al pagar se confirma automáticamente.`
  if (event === 'paid') return `Confírmale al cliente que su pago del pedido #${v.pedido_id} fue recibido y agradécele la compra.`
  if (event === 'status') return `Infórmale al cliente que su pedido #${v.pedido_id} cambió de estado a "${statusEs(v.pedido_estado)}".`
  return ''
}

// Resuelve agente, cuenta y canal de salida de la conversación.
async function resolveConv(accId, agId, convId) {
  const [[c]] = await pool.query('SELECT channel_type, channel_id, wa_from, messenger_from, ig_from FROM conversations WHERE id=? AND account_id=?', [convId, accId])
  if (!c) return null
  const account = await flowStore.loadAccount(accId).catch(() => null)
  const agent = account?.agents?.find(a => a.id === agId) || account?.agents?.[0]
  const to = c.wa_from || c.messenger_from || c.ig_from
  const outbound = (EXTERNAL.has(c.channel_type) && agent) ? buildOutbound(agent, c.channel_type, c.channel_id, to) : null
  return { account, agent, outbound, channelType: c.channel_type }
}

// Genera el mensaje con la IA usando el prompt activo del agente.
async function generateIa(accId, agent, convId, event, v) {
  const active = agent?.prompts?.find(p => p.isActive) || agent?.prompts?.[0]
  const model = active?.model || 'gpt-4o-mini'
  const provider = active?.provider || detectProvider(model)
  const { key } = await resolveProviderKey(accId, provider)
  if (!key) return null
  const persona = active?.content ? `Sigue esta personalidad/estilo:\n${String(active.content).slice(0, 1200)}\n\n` : ''
  const sys = `${persona}Eres ${agent?.name || 'el asistente'} de la tienda. ${iaInstruction(event, v)} Máximo 2 frases, tono natural y cálido, sin inventar datos ni precios. Responde SOLO con el mensaje para el cliente, sin comillas.`
  try {
    const r = await callAI({ provider, model, apiKey: key, systemPrompt: sys, userPrompt: 'Mensaje:', maxTokens: 220, temperature: 0.5 })
    try { require('../controllers/analytics.controller').recordUsageInternal({ accId, agentId: agent?.id, conversationId: convId, provider, model, promptTokens: r.usage?.promptTokens || 0, completionTokens: r.usage?.completionTokens || 0, source: 'order_notify' }) } catch {}
    return (r.text || '').trim()
  } catch (e) { console.warn('[orderNotify IA]', e.message); return null }
}

// Dispara la notificación del evento. `aiCtx` (opcional) = ctx del nodo Agente IA cuando
// el evento ocurre dentro de una herramienta (created): se usa para enviar por ese ctx
// (marca que la herramienta ya envió y evita el mensaje duplicado del modelo).
async function emit(accId, agId, convId, event, vars = {}, aiCtx = null) {
  if (!convId) return
  try {
    const cfg = await store.loadConfig(accId)
    const conf = store.orderNotify(cfg)[event] || { mode: 'off' }
    if (conf.mode === 'off') return
    const rc = await resolveConv(accId, agId, convId)
    if (!rc) return
    const aid = rc.agent?.id || agId
    const outbound = rc.outbound

    if (conf.mode === 'flow' && conf.flowId) {
      await executeFlow({ flowId: conf.flowId, accId, agId: aid, convId, triggerContext: { ...vars, source: 'order', evento: event }, outbound }).catch(e => console.warn('[orderNotify flow]', e.message))
      if (aiCtx) aiCtx._sentCount = (aiCtx._sentCount || 0) + 1   // el flujo ya comunicó → no duplicar
      return
    }

    let text = ''
    if (conf.mode === 'ia' && rc.agent) text = await generateIa(accId, rc.agent, convId, event, vars)
    if (!text) text = defaultMessage(event, vars)   // IA falló o modo default
    if (!text) return
    const sendCtx = aiCtx || { accId, agId: aid, convId, _outbound: outbound }
    await sendBotMsg(sendCtx, text)
  } catch (e) { console.warn('[orderNotify emit]', e.message) }
}

module.exports = { emit, statusEs, EVENTS: store.ORDER_EVENTS }
