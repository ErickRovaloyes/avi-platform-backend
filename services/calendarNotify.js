'use strict'
/**
 * Notificaciones de reservas — ejecutan un FLUJO cuando ocurre un evento de
 * reserva (confirmación, reagendamiento, cancelación, recordatorio). El flujo se
 * ejecuta en la conversación de origen de la reserva (si nació en un chat) o, en
 * su defecto, en una conversación de WhatsApp del cliente o una conversación de
 * tipo formulario, de modo que todo quede relacionado con ese chat.
 *
 * Config en calendar.notifications:
 *   { whatsappAgentId, whatsappChannelId, flowId (por defecto),
 *     events: { confirmation:{ enabled, flowId }, reschedule:{...},
 *               cancellation:{...}, reminder:{ enabled, flowId, minutesBefore } } }
 *
 * Compatibilidad: si un evento no tiene flujo pero sí una plantilla de WhatsApp
 * configurada (template/language/params), se envía la plantilla como antes.
 */

const pool = require('../db')
const { parseJ } = require('../utils')
const {
  sendWhatsAppText, sendWhatsAppMedia, sendMessengerText, sendMessengerButtons, sendInstagramText, sendWhatsAppTemplate, sendWhatsAppCtaUrl,
} = require('./metaSend')

async function resolveWhatsAppChannel(accId, agentId, channelId) {
  const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agentId, accId])
  const channels = parseJ(ag?.channels, [])
  const wa = channels.filter(c => c.type === 'whatsapp')
  return (channelId && wa.find(c => c.id === channelId)) || wa.find(c => c.status === 'connected') || wa[0] || null
}

function interp(text, vars) {
  return String(text || '').replace(/\{\{([^}]+)\}\}/g, (_, k) => vars[k.trim()] ?? '')
}

function bookingVars(calendar, booking) {
  return {
    cliente_nombre: booking.clientName || '', cliente_telefono: booking.clientPhone || '', cliente_email: booking.clientEmail || '',
    reserva_fecha: booking.date, reserva_hora: booking.time, reserva_id: booking.id, calendario: calendar.name || '',
  }
}

// Construye una función outbound para entregar al canal real de una conversación.
function buildOutbound(agent, channelType, channelId, to) {
  const chans = agent?.channels || []
  if (channelType === 'whatsapp') {
    const ch = (channelId && chans.find(c => c.type === 'whatsapp' && c.id === channelId))
      || chans.find(c => c.type === 'whatsapp' && c.status === 'connected')
      || chans.find(c => c.type === 'whatsapp')
    const cfg = ch?.config || agent?.whatsapp || {}
    const num = String(to || '').replace(/[^\d]/g, '')
    if (!cfg.phoneNumberId || !cfg.accessToken || !num) return null
    return async (text, meta) => {
      if (meta?.calendar?.url) {
        try { return await sendWhatsAppCtaUrl({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: num, bodyText: meta.calendar.message || text, buttonText: meta.calendar.buttonText, url: meta.calendar.url }) }
        catch (e) { if (text) return sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: num, text }); throw e }
      }
      if (meta?.media?.url) return sendWhatsAppMedia({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: num, kind: meta.media.kind, link: meta.media.url, caption: meta.caption, filename: meta.media.filename })
      if (text) return sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: num, text })
    }
  }
  if (channelType === 'messenger') {
    const ch = (channelId && chans.find(c => c.type === 'messenger' && c.id === channelId)) || chans.find(c => c.type === 'messenger')
    const cfg = ch?.config || {}
    if (!cfg.pageId || !cfg.pageAccessToken || !to) return null
    return async (text, meta) => {
      if (meta?.calendar?.url) {
        try { return await sendMessengerButtons({ pageId: cfg.pageId, pageAccessToken: cfg.pageAccessToken, recipientId: to, text: meta.calendar.message || text, buttons: [{ type: 'web_url', url: meta.calendar.url, title: (meta.calendar.buttonText || 'Agendar').slice(0, 20) }] }) }
        catch { return sendMessengerText({ pageId: cfg.pageId, pageAccessToken: cfg.pageAccessToken, recipientId: to, text: `${meta.calendar.message ? meta.calendar.message + '\n' : ''}${meta.calendar.url}` }) }
      }
      const body = meta?.media?.url ? `${text ? text + '\n' : ''}${meta.media.url}` : text
      if (body) return sendMessengerText({ pageId: cfg.pageId, pageAccessToken: cfg.pageAccessToken, recipientId: to, text: body })
    }
  }
  if (channelType === 'instagram') {
    const ch = (channelId && chans.find(c => c.type === 'instagram' && c.id === channelId)) || chans.find(c => c.type === 'instagram')
    const cfg = ch?.config || {}
    if (!cfg.igAccountId || !cfg.pageAccessToken || !to) return null
    return async (text, meta) => { const body = meta?.media?.url ? `${text ? text + '\n' : ''}${meta.media.url}` : text; if (body) return sendInstagramText({ igAccountId: cfg.igAccountId, pageAccessToken: cfg.pageAccessToken, recipientId: to, text: body }) }
  }
  return null
}

// Conversación de tipo formulario (último recurso si la reserva no nació en un
// chat ni tiene teléfono). Idempotente por reserva.
async function ensureFormConvo(accId, agentId, calendar, booking) {
  const convId = `conv_form_${booking.id}`
  const ts = Date.now()
  await pool.query(
    `INSERT IGNORE INTO conversations (id, account_id, agent_id, channel_id, channel_type, guest_name, guest_id, initials, preview, unread, ai_enabled, labels, pipeline_cards, local_vars, debug_log, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [convId, accId, agentId, calendar.id, 'form', booking.clientName || 'Reserva', booking.id,
     (booking.clientName || 'R').slice(0, 2).toUpperCase(), `📅 Reserva ${booking.date} ${booking.time}`,
     1, 1, '[]', '[]', JSON.stringify({ booking_id: booking.id }), '[]', ts, ts]
  )
  return convId
}

// Resuelve la conversación de la reserva (la de origen si nació en un chat; si no,
// una de WhatsApp del cliente; en último caso una de tipo formulario) + su outbound.
async function resolveBookingConvo(accId, calendar, booking) {
  const store = require('../flow/store')
  const account = await store.loadAccount(accId)
  if (!account) return null
  const n = calendar.notifications || {}
  const agent = (n.whatsappAgentId && account.agents?.find(a => a.id === n.whatsappAgentId)) || account.agents?.[0]
  if (!agent) return null
  let convId = booking.meta?.conversationId || booking.meta?.convId || null
  let outbound = null
  if (convId) {
    const [[c]] = await pool.query('SELECT * FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (c) { const to = c.wa_from || c.messenger_from || c.ig_from || c.guest_id; outbound = buildOutbound(agent, c.channel_type, c.channel_id, to) }
    else convId = null
  }
  if (!convId && booking.clientPhone) {
    const channel = await resolveWhatsAppChannel(accId, agent.id, n.whatsappChannelId)
    const phone = String(booking.clientPhone).replace(/[^\d]/g, '')
    if (channel && phone) { convId = await store.createOrGetWhatsAppConvo(accId, agent.id, phone, booking.clientName, channel.id); outbound = buildOutbound(agent, 'whatsapp', channel.id, phone) }
  }
  if (!convId) convId = await ensureFormConvo(accId, agent.id, calendar, booking)
  return { account, agent, convId, outbound }
}

// Ejecuta el flujo de notificación de un evento en la conversación adecuada.
async function runEventFlow(accId, calendar, booking, event, flowId) {
  const engine = require('../flow/engine')
  const r = await resolveBookingConvo(accId, calendar, booking)
  if (!r) return false
  const triggerContext = {
    ...bookingVars(calendar, booking),
    booking_id: booking.id, reserva_id: booking.id,
    cliente_nombre: booking.clientName, cliente_telefono: booking.clientPhone, cliente_email: booking.clientEmail,
    reserva_fecha: booking.date, reserva_hora: booking.time, calendario: calendar.name,
    evento: event, notification_event: event,
    message: `Notificación de reserva (${event}): ${booking.date} ${booking.time}`,
  }
  await engine.executeFlow({ flowId, accId, agId: r.agent.id, convId: r.convId, triggerContext, triggeredBy: { type: 'booking' }, outbound: r.outbound })
  console.log(`[calendarNotify] ${event} → flujo ${flowId} (conv ${r.convId})`)
  return true
}

// Envía un texto (mensaje por defecto/integrado) en la conversación de la reserva.
async function sendEventText(accId, calendar, booking, text) {
  const r = await resolveBookingConvo(accId, calendar, booking)
  if (!r) return false
  const { sendBotMsg } = require('../flow/common')
  await sendBotMsg({ accId, agId: r.agent.id, convId: r.convId, _outbound: r.outbound }, interp(text, bookingVars(calendar, booking)))
  return true
}

// Redacta el mensaje con la IA usando el prompt activo del agente y lo envía.
async function notifyIa(accId, calendar, booking, event, instruction) {
  const r = await resolveBookingConvo(accId, calendar, booking)
  if (!r) return false
  const { callAI, detectProvider, resolveProviderKey } = require('../controllers/promptGenerator.controller')
  const active = r.agent?.prompts?.find(p => p.isActive) || r.agent?.prompts?.[0]
  const model = active?.model || 'gpt-4o-mini'
  const provider = active?.provider || detectProvider(model)
  const { key } = await resolveProviderKey(accId, provider)
  if (!key) return false
  const v = bookingVars(calendar, booking)
  const persona = active?.content ? `Sigue esta personalidad/estilo:\n${String(active.content).slice(0, 1000)}\n\n` : ''
  const sys = `${persona}Eres ${r.agent?.name || 'el asistente'}. ${instruction} Datos de la cita — cliente: ${v.cliente_nombre || 'el cliente'}, fecha: ${v.reserva_fecha}, hora: ${v.reserva_hora}, servicio: ${v.calendario}. Máximo 2 frases, tono natural y cálido, sin inventar datos. Responde SOLO con el mensaje para el cliente, sin comillas.`
  try {
    const resp = await callAI({ provider, model, apiKey: key, systemPrompt: sys, userPrompt: 'Mensaje:', maxTokens: 200, temperature: 0.5 })
    const text = (resp.text || '').trim()
    if (!text) return false
    const { sendBotMsg } = require('../flow/common')
    await sendBotMsg({ accId, agId: r.agent.id, convId: r.convId, _outbound: r.outbound }, text)
    return true
  } catch (e) { console.warn('[calendarNotify IA]', e.message); return false }
}

// Legacy: envío de plantilla de WhatsApp (si el evento no tiene flujo).
async function notifyTemplate(accId, calendar, booking, event, cfg) {
  const n = calendar.notifications || {}
  if (!cfg.template || !n.whatsappAgentId) return false
  const channel = await resolveWhatsAppChannel(accId, n.whatsappAgentId, n.whatsappChannelId)
  const c = channel?.config || {}
  if (!c.phoneNumberId || !c.accessToken) return false
  const to = String(booking.clientPhone || '').replace(/[^\d]/g, '')
  if (!to) return false
  const vars = bookingVars(calendar, booking)
  const params = (cfg.params || []).filter(p => p != null && p !== '').map(tok => ({ type: 'text', text: interp(tok, vars) }))
  const components = params.length ? [{ type: 'body', parameters: params }] : []
  await sendWhatsAppTemplate({
    phoneNumberId: c.phoneNumberId, accessToken: c.accessToken,
    to, templateName: cfg.template, languageCode: cfg.language || 'es', components,
  })
  console.log(`[calendarNotify] ${event} → ${to} (plantilla ${cfg.template})`)
  return true
}

// Notifica un evento de reserva según su config:
//   mode 'flow' → ejecuta un flujo · 'ia' → lo redacta la IA con el prompt activo ·
//   'template' → plantilla de WhatsApp · 'default' → mensaje integrado (opts.defaultText).
// opts.force = disparar aunque el evento no tenga enabled:true (eventos de Google).
async function notify(accId, calendar, booking, event, opts = {}) {
  try {
    const n = calendar.notifications || {}
    const cfg = n.events?.[event] || {}
    // opts.mode/opts.flowId permiten forzar el método por reserva (p. ej. una cita manual
    // que elige "confirmación por IA" o "por flujo"), por encima de la config del calendario.
    const mode = opts.mode || cfg.mode || (cfg.flowId ? 'flow' : (cfg.template ? 'template' : 'default'))
    if (mode === 'off') return false
    // Eventos legacy (confirmation/reschedule/cancellation/reminder) requieren enabled:true.
    // Los de Google (confirmed/cancelled_by_guest) usan force → disparan salvo mode='off'.
    if (!opts.force && cfg.enabled !== true) return false
    if (mode === 'flow') { const flowId = opts.flowId || cfg.flowId || n.flowId; if (flowId) return await runEventFlow(accId, calendar, booking, event, flowId) }
    if (mode === 'ia') { const instr = cfg.iaInstruction || opts.iaInstruction; if (instr && await notifyIa(accId, calendar, booking, event, instr)) return true }
    if (mode === 'template' && cfg.template) return await notifyTemplate(accId, calendar, booking, event, cfg)
    // default (o fallback si flow/ia/template no pudieron): mensaje integrado.
    const text = cfg.message || opts.defaultText
    if (text) return await sendEventText(accId, calendar, booking, text)
    return false
  } catch (e) { console.warn('[calendarNotify]', event, e.message); return false }
}

module.exports = { notify, runEventFlow, notifyIa, sendEventText, resolveBookingConvo, resolveWhatsAppChannel, bookingVars, buildOutbound }
