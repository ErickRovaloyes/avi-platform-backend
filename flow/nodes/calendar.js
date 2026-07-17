'use strict'
/**
 * Nodos de Calendario (backend port) — operan sobre el servicio de reservas
 * (services/bookings). Disponibles en flujos de canales reales y, vía el motor
 * del navegador, también en pruebas/webchat.
 */

const { interpolate, logDebug, setVarBoth, sendBotMsg } = require('../common')
const bookings = require('../../services/bookings')
const av = require('../../services/availability')
const restaurant = require('../../services/restaurant')
const cinema = require('../../services/cinema')
const hotelSvc = require('../../services/hotel')

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

  // ── Restaurante (Fase 2c) ──────────────────────────────────────────────────
  {
    type: 'restaurant_availability', category: 'calendar', label: 'Restaurante: ver mesas',
    fields: calFields([
      { key: 'fecha', label: 'Fecha', type: 'text', default: 'hoy' },
      { key: 'personas', label: 'Nº de personas', type: 'text', default: '2' },
      { key: 'destino', label: 'Guardar horarios en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const date = resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId))
      const party = Math.max(1, parseInt(interpolate(node.data?.personas || '2', ctx.variables), 10) || 2)
      const slots = await bookings.getAvailability(ctx.accId, calId, date, undefined, party)
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(slots))
      ctx.variables._restaurant_slots = slots
      ctx.variables._restaurant_date = date
      ctx.variables._restaurant_party = party
      logDebug(ctx, 'flow_run', `🍽 ${slots.length} horario(s) para ${party} persona(s) el ${date}`, { slots })
    },
  },
  {
    type: 'restaurant_book', category: 'calendar', label: 'Restaurante: reservar mesa',
    fields: calFields([
      { key: 'fecha', label: 'Fecha', type: 'text', placeholder: '{{_restaurant_date}}' },
      { key: 'hora', label: 'Hora (HH:MM)', type: 'text' },
      { key: 'personas', label: 'Nº de personas', type: 'text', placeholder: '{{_restaurant_party}}' },
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
      const party = Math.max(1, parseInt(interpolate(node.data?.personas || '2', ctx.variables), 10) || 2)
      const bk = await bookings.createBooking(ctx.accId, calId, {
        date, time, partySize: party,
        clientName: interpolate(node.data?.nombre || '', ctx.variables),
        clientPhone: interpolate(node.data?.telefono || '', ctx.variables),
        clientEmail: interpolate(node.data?.email || '', ctx.variables),
        channel: 'flow', status: 'confirmed',
      }, { validate: true })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, bk.id)
      ctx.variables._last_booking_id = bk.id
      logDebug(ctx, 'flow_run', `✅ Mesa reservada ${bk.id} · ${date} ${time} (${party}p)`, {})
    },
  },
  {
    type: 'restaurant_waitlist', category: 'calendar', label: 'Restaurante: lista de espera',
    fields: calFields([
      { key: 'fecha', label: 'Fecha', type: 'text', placeholder: '{{_restaurant_date}}' },
      { key: 'hora', label: 'Hora (opcional)', type: 'text' },
      { key: 'personas', label: 'Nº de personas', type: 'text', placeholder: '{{_restaurant_party}}' },
      { key: 'nombre', label: 'Nombre del cliente', type: 'text', placeholder: '{{cliente_nombre}}' },
      { key: 'telefono', label: 'Teléfono', type: 'text', placeholder: '{{cliente_telefono}}' },
      { key: 'destino', label: 'Guardar ID de la espera en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const date = resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId))
      const party = Math.max(1, parseInt(interpolate(node.data?.personas || '2', ctx.variables), 10) || 2)
      const w = await restaurant.addWaitlist(ctx.accId, calId, {
        date, time: interpolate(node.data?.hora || '', ctx.variables).slice(0, 5), partySize: party,
        clientName: interpolate(node.data?.nombre || '', ctx.variables),
        clientPhone: interpolate(node.data?.telefono || '', ctx.variables),
      })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, w.id)
      ctx.variables._waitlist_id = w.id
      logDebug(ctx, 'flow_run', `📝 Lista de espera ${w.id} · ${date} (${party}p)`, {})
    },
  },

  // ── Cine (Fase 3c) ─────────────────────────────────────────────────────────
  {
    type: 'cinema_showtimes', category: 'calendar', label: 'Cine: ver funciones',
    fields: calFields([
      { key: 'pelicula', label: 'Película (filtro, opcional)', type: 'text' },
      { key: 'fecha', label: 'Fecha', type: 'text', default: 'hoy' },
      { key: 'destino', label: 'Guardar funciones en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const date = resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId))
      const movieFilter = interpolate(node.data?.pelicula || '', ctx.variables).trim()
      const [shows, movies] = await Promise.all([cinema.listShowtimes(ctx.accId, calId, { date }), cinema.listMovies(ctx.accId, calId)])
      const byId = Object.fromEntries(movies.map(m => [m.id, m]))
      let list = shows.map(s => ({ id: s.id, movie: byId[s.movieId]?.title || '', date: s.date, time: s.time, format: s.format, price: s.price }))
      if (movieFilter) list = list.filter(s => (s.movie || '').toLowerCase().includes(movieFilter.toLowerCase()))
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(list))
      ctx.variables._cinema_showtimes = list
      ctx.variables._cinema_date = date
      logDebug(ctx, 'flow_run', `🎬 ${list.length} función(es) el ${date}`, { list })
    },
  },
  {
    type: 'cinema_book', category: 'calendar', label: 'Cine: comprar entradas',
    fields: calFields([
      { key: 'pelicula', label: 'Película', type: 'text' },
      { key: 'fecha', label: 'Fecha', type: 'text', placeholder: '{{_cinema_date}}' },
      { key: 'hora', label: 'Hora (HH:MM)', type: 'text' },
      { key: 'cantidad', label: 'Nº de entradas', type: 'text', default: '2' },
      { key: 'asientos', label: 'Asientos (opcional, ej: F5,F6)', type: 'text' },
      { key: 'nombre', label: 'Nombre del cliente', type: 'text', placeholder: '{{cliente_nombre}}' },
      { key: 'telefono', label: 'Teléfono', type: 'text', placeholder: '{{cliente_telefono}}' },
      { key: 'destino', label: 'Guardar ID de reserva en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const date = resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId))
      const time = interpolate(node.data?.hora || '', ctx.variables).slice(0, 5)
      const qty = Math.max(1, parseInt(interpolate(node.data?.cantidad || '2', ctx.variables), 10) || 2)
      const seatsRaw = interpolate(node.data?.asientos || '', ctx.variables).trim()
      const seats = seatsRaw ? seatsRaw.split(/[,\s]+/).filter(Boolean) : null
      const booking = await cinema.autoBook(ctx.accId, calId, {
        movie: interpolate(node.data?.pelicula || '', ctx.variables), date, time, qty, seats,
        client: { name: interpolate(node.data?.nombre || '', ctx.variables), phone: interpolate(node.data?.telefono || '', ctx.variables) },
      })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, booking.id)
      ctx.variables._last_booking_id = booking.id
      ctx.variables._cinema_seats = booking.seats
      logDebug(ctx, 'flow_run', `🎟 Entradas ${booking.id} · ${booking.date} ${booking.time} · asientos ${booking.seats.join(', ')}`, {})
    },
  },

  // ── Hotel (Fase 4f) ────────────────────────────────────────────────────────
  {
    type: 'hotel_search', category: 'calendar', label: 'Hotel: ver habitaciones',
    fields: calFields([
      { key: 'checkin', label: 'Check-in (YYYY-MM-DD)', type: 'text' },
      { key: 'checkout', label: 'Check-out (YYYY-MM-DD)', type: 'text' },
      { key: 'huespedes', label: 'Nº de huéspedes', type: 'text', default: '2' },
      { key: 'destino', label: 'Guardar opciones en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const checkin = interpolate(node.data?.checkin || '', ctx.variables).slice(0, 10)
      const checkout = interpolate(node.data?.checkout || '', ctx.variables).slice(0, 10)
      const guests = Math.max(1, parseInt(interpolate(node.data?.huespedes || '2', ctx.variables), 10) || 2)
      const r = await hotelSvc.searchAvailability(ctx.accId, calId, { checkin, checkout, guests })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(r.options))
      ctx.variables._hotel_options = r.options
      ctx.variables._hotel_checkin = checkin
      ctx.variables._hotel_checkout = checkout
      logDebug(ctx, 'flow_run', `🏨 ${r.options.length} habitación(es) ${checkin}→${checkout} (${guests}p)`, { options: r.options })
    },
  },
  {
    type: 'hotel_book', category: 'calendar', label: 'Hotel: reservar habitación',
    fields: calFields([
      { key: 'tipo', label: 'Tipo de habitación (opcional)', type: 'text' },
      { key: 'checkin', label: 'Check-in', type: 'text', placeholder: '{{_hotel_checkin}}' },
      { key: 'checkout', label: 'Check-out', type: 'text', placeholder: '{{_hotel_checkout}}' },
      { key: 'huespedes', label: 'Nº de huéspedes', type: 'text', default: '2' },
      { key: 'nombre', label: 'Nombre del cliente', type: 'text', placeholder: '{{cliente_nombre}}' },
      { key: 'telefono', label: 'Teléfono', type: 'text', placeholder: '{{cliente_telefono}}' },
      { key: 'email', label: 'Email', type: 'text', placeholder: '{{cliente_email}}' },
      { key: 'destino', label: 'Guardar ID de reserva en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const booking = await hotelSvc.autoBook(ctx.accId, calId, {
        roomType: interpolate(node.data?.tipo || '', ctx.variables),
        checkin: interpolate(node.data?.checkin || '', ctx.variables).slice(0, 10),
        checkout: interpolate(node.data?.checkout || '', ctx.variables).slice(0, 10),
        guests: Math.max(1, parseInt(interpolate(node.data?.huespedes || '2', ctx.variables), 10) || 2),
        client: { name: interpolate(node.data?.nombre || '', ctx.variables), phone: interpolate(node.data?.telefono || '', ctx.variables), email: interpolate(node.data?.email || '', ctx.variables) },
      })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, booking.id)
      ctx.variables._last_booking_id = booking.id
      logDebug(ctx, 'flow_run', `🏨 Reserva ${booking.id} · ${booking.roomType} · ${booking.checkin}→${booking.checkout} · ${booking.total} ${booking.currency}`, {})
    },
  },

  // ── Router multi-vertical (contrato uniforme offers[]) ─────────────────────
  {
    type: 'booking_search', category: 'calendar', label: 'Reserva: buscar (cualquier vertical)',
    fields: calFields([
      { key: 'fecha', label: 'Fecha (cita/restaurante/cine)', type: 'text', default: 'hoy' },
      { key: 'checkin', label: 'Check-in (hotel)', type: 'text' },
      { key: 'checkout', label: 'Check-out (hotel)', type: 'text' },
      { key: 'personas', label: 'Nº personas/huéspedes', type: 'text', default: '2' },
      { key: 'destino', label: 'Guardar ofertas en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const router = require('../../core/booking/router')
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const date = resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId))
      const r = await router.search(ctx.accId, calId, {
        date,
        checkin: interpolate(node.data?.checkin || '', ctx.variables).slice(0, 10) || undefined,
        checkout: interpolate(node.data?.checkout || '', ctx.variables).slice(0, 10) || undefined,
        partySize: Math.max(1, parseInt(interpolate(node.data?.personas || '2', ctx.variables), 10) || 2),
      })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(r.offers))
      ctx.variables._offers = r.offers
      ctx.variables._offers_vertical = r.vertical
      logDebug(ctx, 'flow_run', `🔎 ${r.offers.length} oferta(s) [${r.vertical}]`, { offers: r.offers })
    },
  },
  {
    type: 'booking_book', category: 'calendar', label: 'Reserva: confirmar (cualquier vertical)',
    fields: calFields([
      { key: 'offerId', label: 'ID de oferta (hora / función / tipo)', type: 'text' },
      { key: 'fecha', label: 'Fecha (cita/restaurante/cine)', type: 'text' },
      { key: 'checkin', label: 'Check-in (hotel)', type: 'text' },
      { key: 'checkout', label: 'Check-out (hotel)', type: 'text' },
      { key: 'personas', label: 'Nº personas/huéspedes', type: 'text', default: '2' },
      { key: 'nombre', label: 'Nombre del cliente', type: 'text', placeholder: '{{cliente_nombre}}' },
      { key: 'telefono', label: 'Teléfono', type: 'text', placeholder: '{{cliente_telefono}}' },
      { key: 'email', label: 'Email', type: 'text', placeholder: '{{cliente_email}}' },
      { key: 'destino', label: 'Guardar ID de reserva en', type: 'variableRef' },
    ]),
    async exec(node, ctx) {
      const router = require('../../core/booking/router')
      const calId = interpolate(node.data?.calendarId || '', ctx.variables)
      if (!calId) throw new Error('Elige un calendario')
      const booking = await router.book(ctx.accId, calId, {
        offerId: interpolate(node.data?.offerId || '', ctx.variables),
        date: resolveDate(node.data?.fecha, ctx.variables, await calTz(ctx.accId, calId)),
        checkin: interpolate(node.data?.checkin || '', ctx.variables).slice(0, 10) || undefined,
        checkout: interpolate(node.data?.checkout || '', ctx.variables).slice(0, 10) || undefined,
        partySize: Math.max(1, parseInt(interpolate(node.data?.personas || '2', ctx.variables), 10) || 2),
        client: { name: interpolate(node.data?.nombre || '', ctx.variables), phone: interpolate(node.data?.telefono || '', ctx.variables), email: interpolate(node.data?.email || '', ctx.variables) },
      })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, booking.id)
      ctx.variables._last_booking_id = booking.id
      logDebug(ctx, 'flow_run', `✅ Reserva ${booking.id}`, {})
    },
  },
]

module.exports = { calendarNodes }
