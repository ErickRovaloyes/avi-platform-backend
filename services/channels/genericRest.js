'use strict'
/**
 * Fábrica de adaptador REST genérico para PMS/channel managers (HosRoom, Kunas y
 * cualquier otro con API REST + API key). Trae habitaciones (ficha + fotos),
 * disponibilidad/tarifas y reservas. Rutas y forma de auth son configurables, así
 * que conectar = rellenar API key + endpoint (y ajustar rutas si el proveedor usa
 * otras). Mapeo de campos tolerante a varias convenciones de nombres.
 */
const { defineAdapter, httpJson, hasCreds } = require('./base')

const first = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '')
const arr = (x) => (Array.isArray(x) ? x : (x ? [x] : []))

function authOf(config) {
  const mode = config.authMode || 'bearer'
  if (mode === 'apikey_header') return { apiKeyHeader: config.authHeader || 'X-Api-Key', apiKey: config.apiKey }
  return { bearer: config.apiKey }
}
const BASE = (config) => (config.endpoint || '').replace(/\/$/, '')
const qp = (config) => (config.propertyId ? `?property_id=${encodeURIComponent(config.propertyId)}` : '')

function createGenericRest({ id, label, defaults = {} } = {}) {
  return defineAdapter({
    id,
    requires: ['apiKey', 'endpoint'],
    credentialFields: () => [
      { key: 'apiKey', label: 'API Key / Token', type: 'password', required: true },
      { key: 'endpoint', label: `Endpoint base de ${label}`, type: 'text', required: true, help: defaults.endpointHelp || 'URL base de la API REST del proveedor.' },
      { key: 'propertyId', label: 'Property / Hotel ID', type: 'text', required: false },
      { key: 'authMode', label: 'Autenticación', type: 'select', options: ['bearer', 'apikey_header'], required: false, help: 'bearer = Authorization: Bearer; apikey_header = cabecera personalizada.' },
      { key: 'authHeader', label: 'Nombre de cabecera (si apikey_header)', type: 'text', required: false, help: 'Ej: X-Api-Key' },
      { key: 'roomsPath', label: 'Ruta habitaciones (avanzado)', type: 'text', required: false, help: defaults.roomsPath || '/rooms' },
      { key: 'reservationsPath', label: 'Ruta reservas (avanzado)', type: 'text', required: false, help: defaults.reservationsPath || '/reservations' },
      { key: 'availabilityPath', label: 'Ruta disponibilidad (avanzado)', type: 'text', required: false, help: defaults.availabilityPath || '/availability' },
    ],

    async testConnection(config) {
      if (!hasCreds(config, ['apiKey', 'endpoint'])) return { ok: false, message: 'Faltan API Key y endpoint.' }
      try {
        await httpJson(`${BASE(config)}${config.roomsPath || defaults.roomsPath || '/rooms'}${qp(config)}`, { auth: authOf(config) })
        return { ok: true, message: `Conexión ${label} OK` }
      } catch (e) { return { ok: false, message: e.message } }
    },

    async importRoomTypes(config) {
      if (!hasCreds(config, ['apiKey', 'endpoint'])) return []
      const data = await httpJson(`${BASE(config)}${config.roomsPath || defaults.roomsPath || '/rooms'}${qp(config)}`, { auth: authOf(config) })
      const rooms = data?.rooms || data?.data || data?.results || (Array.isArray(data) ? data : [])
      return rooms.map(r => ({
        externalId: String(first(r.id, r.room_id, r.roomId, r.code)),
        name: first(r.name, r.room_name, r.title, `Habitación ${r.id}`),
        description: first(r.description, r.room_description, r.summary, ''),
        capacity: first(r.capacity, r.max_occupancy, r.max_persons, r.occupancy, 2),
        maxCapacity: first(r.max_capacity, r.max_occupancy, r.max_persons, r.capacity, 2),
        totalRooms: first(r.total_rooms, r.units, r.quantity, r.inventory),
        basePrice: Number(first(r.base_price, r.price, r.rate, 0)),
        currency: first(r.currency, 'USD'),
        amenities: arr(first(r.amenities, r.facilities, r.features, [])).map(a => (typeof a === 'string' ? a : first(a.name, a.label, a.title))).filter(Boolean),
        photos: arr(first(r.photos, r.images, r.pictures, [])).map(p => (typeof p === 'string' ? p : first(p.url, p.src, p.large, p.original))).filter(Boolean),
      }))
    },

    async importReservations(config) {
      if (!hasCreds(config, ['apiKey', 'endpoint'])) return []
      const data = await httpJson(`${BASE(config)}${config.reservationsPath || defaults.reservationsPath || '/reservations'}${qp(config)}`, { auth: authOf(config) })
      const list = data?.reservations || data?.bookings || data?.data || data?.results || (Array.isArray(data) ? data : [])
      return list.map(r => ({
        ref: String(first(r.id, r.reservation_id, r.booking_id, r.code)),
        externalRoomId: String(first(r.room_id, r.roomId, r.room?.id, (r.rooms && r.rooms[0]?.id), '')),
        checkin: String(first(r.checkin, r.check_in, r.arrival, r.start_date, '')).slice(0, 10),
        checkout: String(first(r.checkout, r.check_out, r.departure, r.end_date, '')).slice(0, 10),
        guests: first(r.guests, r.pax, r.occupancy, r.adults, 1),
        guestName: first(r.guest_name, r.customer?.name, `${r.first_name || ''} ${r.last_name || ''}`.trim(), 'Huésped'),
        guestPhone: first(r.guest_phone, r.customer?.phone, r.phone, ''),
        guestEmail: first(r.guest_email, r.customer?.email, r.email, ''),
        total: Number(first(r.total, r.total_price, r.amount, 0)),
        currency: first(r.currency, 'USD'),
        status: String(first(r.status, 'confirmed')).toLowerCase().includes('cancel') ? 'cancelled' : 'confirmed',
      }))
    },

    async importAvailability(config, { from, to } = {}) {
      if (!hasCreds(config, ['apiKey', 'endpoint'])) return []
      const sep = qp(config) ? '&' : '?'
      const data = await httpJson(`${BASE(config)}${config.availabilityPath || defaults.availabilityPath || '/availability'}${qp(config)}${from ? `${sep}from=${from}&to=${to}` : ''}`, { auth: authOf(config) })
      const list = data?.availability || data?.data || (Array.isArray(data) ? data : [])
      return list.map(a => ({ externalRoomId: String(first(a.room_id, a.roomId, a.id)), date: String(first(a.date, a.day)).slice(0, 10), available: first(a.available, a.allotment, a.count, 0), price: Number(first(a.price, a.rate, 0)) }))
    },

    async pushAvailability(config, { externalRoomId, updates }) {
      if (!hasCreds(config, ['apiKey', 'endpoint'])) return { ok: false, error: 'Sin credenciales' }
      await httpJson(`${BASE(config)}${config.availabilityPath || defaults.availabilityPath || '/availability'}`, { method: 'POST', auth: authOf(config), body: { property_id: config.propertyId, room_id: externalRoomId, updates } })
      return { ok: true }
    },
  })
}

module.exports = { createGenericRest }
