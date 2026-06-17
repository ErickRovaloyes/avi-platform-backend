'use strict'
/**
 * TimeSlotStrategy — estrategia de disponibilidad basada en franjas de tiempo.
 *
 * Es la estrategia del vertical actual (médico/consultorio/coach/salón): la
 * unidad reservable es un slot de tiempo en la agenda. Envuelve el motor puro
 * existente (services/availability.computeSlots) SIN cambiar su comportamiento.
 *
 * En fases siguientes se añadirán hermanas que implementan la misma interfaz:
 *   - CapacityStrategy   (restaurantes: mesas + rotación + turnos)
 *   - InventoryStrategy  (hotel: room-nights por rango de fechas)
 *   - SeatMapStrategy    (cine: asientos discretos + holds TTL)
 *
 * Interfaz AvailabilityStrategy (Fase 0, parte time-based):
 *   id
 *   slots(calendar, dateStr, bookings, opts) -> string[]   (cálculo puro)
 *   getDayAvailability(calendar, dateStr, { durationMin, ctx }) -> string[]
 *   ctx = { holidayBlocked, bookingsForDate, googleBusyForDate }
 */

const av = require('../../services/availability')

module.exports = {
  id: 'time_slot',

  // Cálculo puro de slots libres (delegado al motor existente). Sin I/O.
  slots(calendar, dateStr, bookings = [], opts = {}) {
    return av.computeSlots(calendar, dateStr, bookings, opts)
  },

  // Disponibilidad de un día concreto: festivos + reservas + ocupado de Google.
  // La carga de datos llega por `ctx` (inyección) para no acoplar la estrategia
  // a la capa de datos y mantenerla testeable.
  async getDayAvailability(calendar, dateStr, { durationMin, ctx } = {}) {
    if (ctx?.holidayBlocked && await ctx.holidayBlocked(calendar, dateStr)) return []
    const bookings = ctx?.bookingsForDate ? await ctx.bookingsForDate(calendar.accountId, calendar.id, dateStr) : []
    const gBusy = ctx?.googleBusyForDate ? await ctx.googleBusyForDate(calendar.accountId, calendar, dateStr) : []
    return av.computeSlots(calendar, dateStr, [...bookings, ...gBusy], { durationMin })
  },
}
