'use strict'
/**
 * InventoryStrategy — vertical hotel. La unidad reservable es la NOCHE de un
 * tipo de habitación; una estadía ocupa varias noches. La disponibilidad real
 * (rango + tipo + huéspedes + cotización) es específica de hotel y se maneja por
 * endpoints dedicados (services/hotel: searchAvailability/quoteStay/bookStay).
 * Aquí solo implementamos la parte de la interfaz común útil para la cuadrícula:
 * los días seleccionables como CHECK-IN (con al menos un tipo con cupo).
 */

const hotel = require('../../services/hotel')

module.exports = {
  id: 'inventory',

  // Una "hora" no aplica; devolvemos un marcador si el día tiene cupo.
  async getDayAvailability(calendar, dateStr) {
    const r = await hotel.monthCheckinDays(calendar.accountId, calendar.id, dateStr.slice(0, 4), Number(dateStr.slice(5, 7)))
    return r.days.includes(dateStr) ? ['disponible'] : []
  },

  async getMonthDays(calendar, { year, month } = {}) {
    return hotel.monthCheckinDays(calendar.accountId, calendar.id, year, month)
  },
}
