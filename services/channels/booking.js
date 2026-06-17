'use strict'
/**
 * Adaptador Booking.com (Connectivity / Content & Reservations API).
 * Auth por cuenta máquina (usuario/clave) y hotel_id. La API de conectividad
 * requiere certificación de partner; aquí queda cableada para que SOLO sea cargar
 * credenciales. Endpoint y rutas son configurables por si tu integración usa otra.
 */
const { defineAdapter, httpJson, hasCreds } = require('./base')

const BASE = (config) => (config.endpoint || 'https://supply-xml.booking.com').replace(/\/$/, '')
const basic = (config) => ({ basic: { user: config.username, pass: config.password } })

module.exports = defineAdapter({
  id: 'booking',
  requires: ['username', 'password', 'hotelId'],
  credentialFields: () => [
    { key: 'username', label: 'Usuario (cuenta máquina)', type: 'text', required: true },
    { key: 'password', label: 'Contraseña / API Key', type: 'password', required: true },
    { key: 'hotelId', label: 'Hotel ID (property id)', type: 'text', required: true },
    { key: 'endpoint', label: 'Endpoint (avanzado)', type: 'text', required: false, help: 'Por defecto https://supply-xml.booking.com' },
    { key: 'roomsPath', label: 'Ruta de habitaciones (avanzado)', type: 'text', required: false, help: 'Por defecto /json/getRooms' },
    { key: 'reservationsPath', label: 'Ruta de reservas (avanzado)', type: 'text', required: false, help: 'Por defecto /json/reservations' },
  ],

  async testConnection(config) {
    if (!hasCreds(config, ['username', 'password', 'hotelId'])) return { ok: false, message: 'Faltan usuario, contraseña y hotel ID.' }
    try {
      await httpJson(`${BASE(config)}${config.roomsPath || '/json/getRooms'}?hotel_id=${encodeURIComponent(config.hotelId)}`, { auth: basic(config) })
      return { ok: true, message: 'Conexión Booking.com OK' }
    } catch (e) { return { ok: false, message: e.message } }
  },

  async importRoomTypes(config) {
    if (!hasCreds(config, ['username', 'password', 'hotelId'])) return []
    const data = await httpJson(`${BASE(config)}${config.roomsPath || '/json/getRooms'}?hotel_id=${encodeURIComponent(config.hotelId)}`, { auth: basic(config) })
    const rooms = data?.rooms || data?.data || data?.result || []
    return rooms.map(r => ({
      externalId: String(r.room_id || r.id),
      name: r.name || r.room_name || `Habitación ${r.room_id}`,
      description: r.description || r.room_description || '',
      capacity: r.max_persons || r.occupancy || 2,
      maxCapacity: r.max_persons || r.occupancy || 2,
      totalRooms: r.number_of_rooms || r.units,
      basePrice: Number(r.price || r.rate || 0),
      currency: r.currency || 'USD',
      amenities: (r.facilities || r.amenities || []).map(a => (typeof a === 'string' ? a : a.name)).filter(Boolean),
      photos: (r.photos || r.images || []).map(p => (typeof p === 'string' ? p : (p.url || p.url_max300 || p.url_original))).filter(Boolean),
    }))
  },

  async importReservations(config) {
    if (!hasCreds(config, ['username', 'password', 'hotelId'])) return []
    const data = await httpJson(`${BASE(config)}${config.reservationsPath || '/json/reservations'}?hotel_id=${encodeURIComponent(config.hotelId)}`, { auth: basic(config) })
    const list = data?.reservations || data?.data || []
    return list.map(r => ({
      ref: String(r.reservation_id || r.id),
      externalRoomId: String(r.room_id || (r.rooms && r.rooms[0]?.room_id) || ''),
      checkin: (r.checkin || r.arrival_date || '').slice(0, 10),
      checkout: (r.checkout || r.departure_date || '').slice(0, 10),
      guests: r.guests || r.occupancy || 1,
      guestName: r.customer?.name || `${r.customer?.first_name || ''} ${r.customer?.last_name || ''}`.trim() || 'Huésped Booking',
      guestPhone: r.customer?.telephone || r.customer?.phone || '',
      guestEmail: r.customer?.email || '',
      total: Number(r.total_price || r.price || 0),
      currency: r.currency || 'USD',
      status: (r.status || '').toLowerCase() === 'cancelled' ? 'cancelled' : 'confirmed',
    }))
  },

  async pushAvailability(config, { externalRoomId, updates }) {
    // OTA_HotelAvailNotif equivalente (JSON). Estructura lista para credenciales reales.
    if (!hasCreds(config, ['username', 'password', 'hotelId'])) return { ok: false, error: 'Sin credenciales' }
    await httpJson(`${BASE(config)}/json/availability`, { method: 'POST', auth: basic(config), body: { hotel_id: config.hotelId, room_id: externalRoomId, availability: updates } })
    return { ok: true }
  },
  async pushRates(config, { externalRoomId, rates }) {
    if (!hasCreds(config, ['username', 'password', 'hotelId'])) return { ok: false, error: 'Sin credenciales' }
    await httpJson(`${BASE(config)}/json/rates`, { method: 'POST', auth: basic(config), body: { hotel_id: config.hotelId, room_id: externalRoomId, rates } })
    return { ok: true }
  },
})
