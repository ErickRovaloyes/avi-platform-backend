'use strict'
/**
 * Registro de estrategias de disponibilidad del Core Booking Engine.
 *
 * resolveStrategy(calendar) elige la estrategia según el `vertical` del recurso.
 * En la Fase 0 todos los verticales time-based resuelven a TimeSlotStrategy, por
 * lo que el comportamiento es idéntico al actual. Las fases siguientes registran
 * CapacityStrategy (restaurante), InventoryStrategy (hotel) y SeatMapStrategy (cine).
 */

const timeSlot = require('./timeSlot')
const capacity = require('./capacity')

const STRATEGIES = {
  time_slot:   timeSlot,
  appointment: timeSlot,   // vertical actual por defecto
  medical:     timeSlot,
  restaurant:  capacity,   // Fase 2
  // hotel:      inventory,  // Fase 4
  // cinema:     seatMap,    // Fase 3
}

function resolveStrategy(calendar) {
  const key = calendar?.availabilityStrategy || calendar?.vertical || 'appointment'
  return STRATEGIES[key] || timeSlot
}

module.exports = { resolveStrategy, STRATEGIES, timeSlot, capacity }
