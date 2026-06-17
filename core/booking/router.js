'use strict'
/**
 * Router de reservas multi-vertical (contrato uniforme `offers[]`).
 *
 * Un único punto de entrada que DETECTA el vertical del calendario y devuelve las
 * opciones reservables en una forma uniforme, de modo que un mismo asistente IA
 * (o cliente API) razona igual sin importar el vertical:
 *
 *   offer = { offerId, label, price?, meta? }
 *
 * - médico/cita / restaurante → offerId = hora "HH:MM"
 * - cine                      → offerId = showtimeId
 * - hotel                     → offerId = roomTypeId
 *
 * book(selection) consume el offerId + el contexto (date/checkin/checkout/partySize)
 * y delega en el servicio del vertical.
 */

const bookings = require('../../services/bookings')
const cinema = require('../../services/cinema')
const hotel = require('../../services/hotel')

async function search(accId, calId, q = {}) {
  const cal = await bookings.getCalendar(accId, calId)
  if (!cal) throw new Error('Calendario no encontrado')
  const v = cal.vertical || 'appointment'

  if (v === 'cinema') {
    const [shows, movies] = await Promise.all([
      cinema.listShowtimes(accId, calId, q.date ? { date: q.date } : {}),
      cinema.listMovies(accId, calId),
    ])
    const byId = Object.fromEntries(movies.map(m => [m.id, m]))
    return {
      vertical: v,
      offers: shows.map(s => ({ offerId: s.id, label: `${byId[s.movieId]?.title || ''} · ${s.date} ${s.time} · ${s.format}`.trim(), price: s.price, meta: { date: s.date, time: s.time, movie: byId[s.movieId]?.title } })),
    }
  }
  if (v === 'hotel') {
    const r = await hotel.searchAvailability(accId, calId, { checkin: q.checkin, checkout: q.checkout, guests: q.partySize })
    return {
      vertical: v,
      offers: r.options.map(o => ({ offerId: o.roomTypeId, label: `${o.name} · ${o.nights} noche(s)`, price: o.total, meta: { nights: o.nights, currency: o.currency, capacity: o.capacity } })),
    }
  }
  // Time-based (médico/cita) y restaurante: horas disponibles.
  const slots = await bookings.getAvailability(accId, calId, q.date, q.duration, q.partySize)
  return { vertical: v, offers: slots.map(t => ({ offerId: t, label: t, meta: { time: t } })) }
}

async function book(accId, calId, sel = {}) {
  const cal = await bookings.getCalendar(accId, calId)
  if (!cal) throw new Error('Calendario no encontrado')
  const v = cal.vertical || 'appointment'
  const client = sel.client || {}

  if (v === 'cinema') {
    return cinema.bookShowtimeAuto(accId, sel.offerId, Math.max(1, Number(sel.partySize) || 1), client)
  }
  if (v === 'hotel') {
    return hotel.bookStay(accId, calId, { roomTypeId: sel.offerId, checkin: sel.checkin, checkout: sel.checkout, guests: Math.max(1, Number(sel.partySize) || 2), client, channel: 'flow' })
  }
  // restaurante / time-based: offerId = hora
  return bookings.createBooking(accId, calId, {
    date: sel.date, time: sel.offerId, partySize: sel.partySize,
    clientName: client.name, clientPhone: client.phone, clientEmail: client.email,
    channel: 'flow', status: 'confirmed',
  }, { validate: true })
}

module.exports = { search, book }
