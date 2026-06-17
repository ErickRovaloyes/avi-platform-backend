'use strict'
/**
 * Adaptador Airbnb. La API oficial de Airbnb es de PARTNER (requiere convenio y un
 * access token OAuth). Si hay `apiToken`, usa la API (listados con fotos/descripción
 * + reservas). Si no, cae a iCal (que sí funciona sin convenio para bloquear fechas).
 *
 * Para conectar: rellena el Access Token (y opcional User ID) cuando tengas acceso
 * de partner; o solo la URL iCal del listado para sincronización de fechas.
 */
const { defineAdapter, httpJson, hasCreds } = require('./base')

const API = (config) => (config.endpoint || 'https://api.airbnb.com/v2').replace(/\/$/, '')

module.exports = defineAdapter({
  id: 'airbnb',
  requires: ['apiToken'],
  credentialFields: () => [
    { key: 'apiToken', label: 'Access Token (OAuth de partner)', type: 'password', required: false, help: 'Token de la API oficial de Airbnb (requiere convenio de partner).' },
    { key: 'userId', label: 'User ID / Host ID', type: 'text', required: false },
    { key: 'endpoint', label: 'Endpoint API (avanzado)', type: 'text', required: false, help: 'Por defecto https://api.airbnb.com/v2' },
    { key: 'icalImportUrl', label: 'URL iCal del listado (alternativa sin API)', type: 'text', required: false, help: 'Airbnb → Calendario → Disponibilidad → Conectar calendario → Exportar.' },
  ],

  async testConnection(config) {
    if (config.apiToken) {
      try { await httpJson(`${API(config)}/listings?_limit=1${config.userId ? `&user_id=${config.userId}` : ''}`, { auth: { bearer: config.apiToken } }); return { ok: true, message: 'Conexión API Airbnb OK' } }
      catch (e) { return { ok: false, message: e.message } }
    }
    if (config.icalImportUrl) return { ok: true, message: 'Modo iCal (sin API). Las fechas se sincronizarán por calendario.' }
    return { ok: false, message: 'Falta Access Token de partner o URL iCal.' }
  },

  async importRoomTypes(config) {
    if (!hasCreds(config, ['apiToken'])) return [] // sin API → no hay ficha (solo iCal de fechas)
    const data = await httpJson(`${API(config)}/listings?_limit=50${config.userId ? `&user_id=${config.userId}` : ''}`, { auth: { bearer: config.apiToken } })
    const listings = data?.listings || data?.data || []
    return listings.map(l => ({
      externalId: String(l.id),
      name: l.name || l.listing?.name || `Listado ${l.id}`,
      description: l.summary || l.description || l.listing?.description || '',
      capacity: l.person_capacity || l.bedrooms || 2,
      maxCapacity: l.person_capacity || 2,
      basePrice: Number(l.price || l.listing_native_currency_price || 0),
      currency: l.native_currency || 'USD',
      amenities: (l.amenities || l.listing_amenities || []).map(a => (typeof a === 'string' ? a : a.name)).filter(Boolean),
      photos: (l.photos || l.picture_urls || []).map(p => (typeof p === 'string' ? p : (p.large || p.picture || p.url))).filter(Boolean),
    }))
  },

  async importReservations(config) {
    if (!hasCreds(config, ['apiToken'])) return [] // sin API → las reservas llegan por iCal (en hotelChannels)
    const data = await httpJson(`${API(config)}/reservations?_limit=100`, { auth: { bearer: config.apiToken } })
    const list = data?.reservations || data?.data || []
    return list.map(r => ({
      ref: String(r.confirmation_code || r.id),
      externalRoomId: String(r.listing_id || ''),
      checkin: (r.start_date || r.check_in || '').slice(0, 10),
      checkout: (r.end_date || r.check_out || '').slice(0, 10),
      guests: r.guests || r.number_of_guests || 1,
      guestName: r.guest?.full_name || r.guest_details?.localized_description || 'Huésped Airbnb',
      guestPhone: r.guest?.phone || '',
      guestEmail: r.guest?.email || '',
      total: Number(r.total_price || r.payout_price || 0),
      currency: r.native_currency || 'USD',
      status: (r.status || 'accepted').toLowerCase().includes('cancel') ? 'cancelled' : 'confirmed',
    }))
  },
})
