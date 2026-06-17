'use strict'
/**
 * SeatMapStrategy — vertical cine. La unidad reservable es el ASIENTO de una
 * FUNCIÓN (mapa discreto + holds con TTL), que es específico de cine y se maneja
 * por endpoints dedicados (services/cinema). Aquí solo implementamos la parte de
 * la interfaz común que tiene sentido para la cuadrícula mensual / lista de horas:
 * los horarios de funciones de un día y los días con funciones del mes.
 */

const cinema = require('../../services/cinema')

module.exports = {
  id: 'seat_map',

  // Horas de funciones de un día (lista simple; la selección de asientos es aparte).
  async getDayAvailability(calendar, dateStr) {
    const shows = await cinema.listShowtimes(calendar.accountId, calendar.id, { date: dateStr })
    return [...new Set(shows.map(s => s.time).filter(Boolean))].sort()
  },

  // Días del mes con al menos una función.
  async getMonthDays(calendar, { year, month } = {}) {
    const y = Number(year), m = Number(month), mm = String(m).padStart(2, '0')
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const first = `${y}-${mm}-01`, last = `${y}-${mm}-${String(lastDay).padStart(2, '0')}`
    const shows = await cinema.listShowtimes(calendar.accountId, calendar.id, { from: first, to: last })
    const days = [...new Set(shows.map(s => s.date).filter(Boolean))].sort()
    return { year: y, month: m, days }
  },
}
