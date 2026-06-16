'use strict'
/**
 * Notificaciones de reservas por WhatsApp — envía una plantilla aprobada de Meta
 * cuando ocurre un evento de reserva (confirmación, reagendamiento, cancelación,
 * recordatorio). Reutiliza la infraestructura de WhatsApp Business de la cuenta.
 *
 * Config en calendar.notifications:
 *   { whatsappAgentId, whatsappChannelId,
 *     events: { confirmation:{enabled,template,language,params:[]}, reschedule:{...},
 *               cancellation:{...}, reminder:{enabled,template,language,params,minutesBefore} } }
 *   params: tokens en orden de los parámetros del cuerpo de la plantilla
 *           (ej. "{{cliente_nombre}}", "{{reserva_fecha}}", "{{reserva_hora}}").
 */

const pool = require('../db')
const { parseJ } = require('../utils')
const { sendWhatsAppTemplate } = require('./metaSend')

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

// Envía la notificación de un evento si está configurada. Best-effort (no lanza).
async function notify(accId, calendar, booking, event) {
  try {
    const n = calendar.notifications || {}
    const cfg = n.events?.[event]
    if (!cfg?.enabled || !cfg.template || !n.whatsappAgentId) return false
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
    console.log(`[calendarNotify] ${event} → ${to} (${cfg.template})`)
    return true
  } catch (e) { console.warn('[calendarNotify]', event, e.message); return false }
}

module.exports = { notify, resolveWhatsAppChannel, bookingVars }
