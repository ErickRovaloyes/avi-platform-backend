'use strict'
/**
 * Nodos de Calendario (backend port) — operan sobre el servicio de reservas
 * (services/bookings). Disponibles en flujos de canales reales y, vía el motor
 * del navegador, también en pruebas/webchat.
 */

const { interpolate, logDebug, setVarBoth, sendBotMsg } = require('../common')
const bookings = require('../../services/bookings')
const av = require('../../services/availability')

// Base pública para construir el enlace ABSOLUTO de la página de reservas.
// Debe ser absoluta para que WhatsApp la haga clickeable / acepte el botón CTA.
function publicBase() {
  return (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function resolveDate(raw, vars, tz) {
  const v = interpolate(raw || '', vars).trim().toLowerCase()
  const today = av.nowInTz(tz).date
  if (!v || v === 'hoy' || v === 'today') return today
  if (['mañana', 'manana', 'tomorrow'].includes(v)) return addDays(today, 1)
  const m = v.match(/^\+(\d+)d$/)
  if (m) return addDays(today, parseInt(m[1], 10))
  return v.slice(0, 10)
}
async function calTz(accId, calId) {
  try { const c = await bookings.getCalendar(accId, calId); return c?.timezone } catch { return undefined }
}

const calFields = (extra = []) => [
  { key: 'calendarId', label: 'Calendario', type: 'calendarRef' },
  ...extra,
]

const calendarNodes = [
  {
    type: 'send_calendar', category: 'calendar', label: 'Enviar calendario',
    fields: calFields([
      { key: 'mensaje', label: 'Mensaje', type: 'textarea', default: 'Agenda tu cita en el siguiente enlace:' },
      { key: 'buttonText', label: 'Texto del botón', type: 'text', default: '📅 Agendar cita' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const cal = await bookings.getCalendar(ctx.accId, calId)
      if (!cal) throw new Error('Calendario no encontrado')
      const msg = interpolate(node.data?.mensaje || 'Agenda tu cita:', ctx.variables)
      const buttonText = interpolate(node.data?.buttonText || '📅 Agendar cita', ctx.variables)
      // La reserva queda referenciada a ESTA conversación (?conv=) → las
      // notificaciones de la reserva correrán en este mismo chat.
      const url = `${publicBase()}/book/${ctx.accId}/${calId}?conv=${encodeURIComponent(ctx.convId)}`
      // Texto con el enlace (clickeable en WhatsApp) + metadata. En WhatsApp el
      // outbound usa la metadata para enviar un botón interactivo CTA-URL; en
      // webchat/inbox renderiza la tarjeta de calendario (CalendarMessage).
      await sendBotMsg(ctx, `${msg}\n${url}`, {
        calendar: { accId: ctx.accId, calId, convId: ctx.convId, name: cal.name, color: cal.color || '#7c6fff', buttonText, url, message: msg },
      })
      logDebug(ctx, 'flow_run', `🗓 Calendario enviado: ${cal.name}`, { url })
    },
  },
  {
    type: 'calendar_check', category: 'calendar', label: 'Consultar disponibilidad',
    fields: calFields([
      { key: 'fecha', label: 'Fecha', type: 'text', default: 'hoy' },
      { key: 'duracion', label: 'Duración (min, opcional)', type: 'number' },
      { key: 'destino', label: 'Guardar horarios en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const date = resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId))
      const slots = await bookings.getAvailability(ctx.accId, calId, date, node.data?.duracion ? Number(node.data.duracion) : undefined)
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(slots))
      ctx.variables._calendar_slots = slots
      ctx.variables._calendar_date = date
      logDebug(ctx, 'flow_run', `🗓 ${slots.length} horario(s) libres el ${date}`, { slots })
    },
  },
  {
    type: 'calendar_list_bookings', category: 'calendar', label: 'Consultar reservas',
    fields: calFields([
      { key: 'fecha', label: 'Fecha', type: 'text', default: 'hoy' },
      { key: 'destino', label: 'Guardar reservas en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const date = resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId))
      const list = await bookings.listBookings(ctx.accId, calId, { date })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(list))
      ctx.variables._calendar_bookings = list
      logDebug(ctx, 'flow_run', `📋 ${list.length} reserva(s) el ${date}`, {})
    },
  },
  {
    type: 'calendar_book', category: 'calendar', label: 'Crear reserva',
    fields: calFields([
      { key: 'fecha', label: 'Fecha', type: 'text', placeholder: '{{reserva_fecha}}' },
      { key: 'hora', label: 'Hora (HH:MM)', type: 'text', placeholder: '{{reserva_hora}}' },
      { key: 'duracion', label: 'Duración (min, opcional)', type: 'number' },
      { key: 'nombre', label: 'Nombre del cliente', type: 'text', placeholder: '{{cliente_nombre}}' },
      { key: 'telefono', label: 'Teléfono', type: 'text', placeholder: '{{cliente_telefono}}' },
      { key: 'email', label: 'Email', type: 'text', placeholder: '{{cliente_email}}' },
      { key: 'destino', label: 'Guardar ID de reserva en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const date = resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId))
      const time = interpolate(node.data?.hora || '', ctx.variables).slice(0, 5)
      const bk = await bookings.createBooking(ctx.accId, calId, {
        date, time,
        duration: node.data?.duracion ? Number(node.data.duracion) : undefined,
        clientName: interpolate(node.data?.nombre || '', ctx.variables),
        clientPhone: interpolate(node.data?.telefono || '', ctx.variables),
        clientEmail: interpolate(node.data?.email || '', ctx.variables),
        channel: 'flow', status: 'confirmed',
      }, { validate: true })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, bk.id)
      ctx.variables._last_booking_id = bk.id
      logDebug(ctx, 'flow_run', `✅ Reserva ${bk.id} · ${date} ${time}`, {})
    },
  },
  {
    type: 'calendar_reschedule', category: 'calendar', label: 'Reagendar reserva',
    fields: [
      { key: 'bookingId', label: 'ID de la reserva', type: 'text', placeholder: '{{_last_booking_id}}' },
      { key: 'calendarId', label: 'Calendario (para resolver fecha relativa)', type: 'calendarRef' },
      { key: 'fecha', label: 'Nueva fecha', type: 'text' },
      { key: 'hora', label: 'Nueva hora (HH:MM)', type: 'text' },
      { key: 'destino', label: 'Guardar estado en', type: 'variableRef' },
    ],
    async exec(node, ctx) {
      const bookingId = interpolate(node.data?.bookingId || '', ctx.variables)
      if (!bookingId) throw new Error('Falta el ID de la reserva')
      const tz = node.data?.calendarId ? await calTz(ctx.accId, interpolate(node.data.calendarId, ctx.variables)) : undefined
      const date = resolveDate(node.data?.fecha, ctx.variables, tz)
      const time = interpolate(node.data?.hora || '', ctx.variables).slice(0, 5)
      const bk = await bookings.rescheduleBooking(ctx.accId, bookingId, date, time, { validate: true })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, bk.status)
      ctx.variables._last_booking_status = bk.status
      logDebug(ctx, 'flow_run', `🔁 Reserva ${bookingId} reagendada a ${date} ${time}`, {})
    },
  },
  {
    type: 'calendar_cancel', category: 'calendar', label: 'Cancelar reserva',
    fields: [
      { key: 'bookingId', label: 'ID de la reserva', type: 'text', placeholder: '{{_last_booking_id}}' },
      { key: 'destino', label: 'Guardar confirmación en', type: 'variableRef' },
    ],
    async exec(node, ctx) {
      const bookingId = interpolate(node.data?.bookingId || '', ctx.variables)
      if (!bookingId) throw new Error('Falta el ID de la reserva')
      const bk = await bookings.cancelBooking(ctx.accId, bookingId)
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, bk?.status || 'cancelled')
      ctx.variables._last_booking_status = bk?.status || 'cancelled'
      logDebug(ctx, 'flow_run', `🚫 Reserva ${bookingId} cancelada`, {})
    },
  },
  {
    type: 'calendar_get', category: 'calendar', label: 'Obtener reserva',
    fields: [
      { key: 'bookingId', label: 'ID de la reserva', type: 'text', placeholder: '{{_last_booking_id}}' },
      { key: 'destino', label: 'Guardar datos (JSON) en', type: 'variableRef' },
    ],
    async exec(node, ctx) {
      const bookingId = interpolate(node.data?.bookingId || '', ctx.variables)
      if (!bookingId) throw new Error('Falta el ID de la reserva')
      const bk = await bookings.getBooking(ctx.accId, bookingId)
      if (!bk) throw new Error('Reserva no encontrada')
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(bk))
      ctx.variables._last_booking = bk
      logDebug(ctx, 'flow_run', `🔎 Reserva ${bookingId} · ${bk.status}`, {})
    },
  },
]

module.exports = { calendarNodes }
