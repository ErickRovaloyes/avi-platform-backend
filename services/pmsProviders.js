'use strict'
/**
 * Proveedores PMS para la Herramienta IA Especial "pms".
 *
 * HosRoom — integración REAL contra su Booking Engine (spec OpenAPI oficial):
 *   GET  /api/hotel                  → sesión del hotel (prueba de conexión)
 *   GET  /api/engine/settings        → habitaciones (ficha + galería de fotos + planes/tarifas)
 *   GET  /api/engine/availability    → disponibilidad por checkin/checkout + ocupación
 *   POST /api/engine/book            → crear reserva (customer, source:'bot', link de pago)
 *   GET  /api/engine/status/{code}   → detalle/estado de una reserva (HR-XXXX)
 * Autenticación: Authorization: Bearer <token del HOTEL>. El token debe ser el del
 * hotel (no el de un usuario) y el hotel debe tener habilitada la integración
 * "Motor de reservas" en HosRoom. Base: https://sys.hosroom.com
 * NOTA: el engine NO expone cancelar/reagendar; esas operaciones van como
 * "solicitud gestionada" (nota interna + aviso al equipo) desde services/pms.js.
 *
 * Kunas — en la lista, pendiente de documentación oficial (mismo contrato).
 */

const first = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '')
const arr = x => (Array.isArray(x) ? x : (x ? [x] : []))

// ── Transporte HosRoom ─────────────────────────────────────────────────────────
// La API de HosRoom usa Authorization: Bearer <token del hotel>. El token debe ser
// el del HOTEL (no el de un usuario) y el hotel debe tener habilitada la integración
// "Motor de reservas". Los mensajes de error traducen los casos típicos.
async function hosFetch(cfg, path, { method = 'GET', body, query } = {}) {
  const base = (cfg.baseUrl || 'https://sys.hosroom.com').replace(/\/$/, '')
  const url = new URL(`${base}${path}`)
  for (const [k, v] of Object.entries(query || {})) { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)) }
  const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${cfg.token}` }
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let data = null; try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    const raw = typeof data === 'string' ? data.slice(0, 200) : (data?.message || JSON.stringify(data?.errors || data || {}).slice(0, 200))
    let msg = `HosRoom ${res.status}: ${raw}`
    if (res.status === 401) msg = 'HosRoom: el token es inválido o no es un token de HOTEL. Usa el token que genera HosRoom en Configuración → Integraciones → Motor de reservas (no el token de tu usuario).'
    else if (/sesi[oó]n de hotel/i.test(raw)) msg = 'HosRoom: el token no está asociado a un hotel con el "Motor de reservas" habilitado. Habilita la integración "Canales de reserva" + "Motor de reservas" en HosRoom (Configuración → Integraciones) y usa el token que te da esa integración.'
    throw Object.assign(new Error(msg), { status: res.status })
  }
  return data
}

// ── Normalizadores tolerantes ─────────────────────────────────────────────────
function normRoom(r) {
  return {
    id: String(first(r.id, r.room_id, r.code, '')),
    name: first(r.name, r.title, 'Habitación'),
    capacity: Number(first(r.capacity, r.max_occupancy, 2)),
    description: first(r.description, r.summary, ''),
    photos: arr(first(r.gallery, r.photos, r.images, [])).map(p => (typeof p === 'string' ? p : first(p.url, p.src, p.original))).filter(Boolean),
    rates: arr(first(r.rates, r.plans, [])).map(normRate),
    raw: r,
  }
}
function sumDays(days) {
  if (!days || typeof days !== 'object') return null
  const vals = Object.values(days).map(Number).filter(n => !isNaN(n))
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null
}
function normRate(rt) {
  return {
    id: String(first(rt.id, rt.rate_id, rt.rate_plan_id, '')),
    name: first(rt.name, rt.title, 'Tarifa'),
    capacity: Number(first(rt.capacity, 0)) || null,
    description: first(rt.description, '') || '',
    mealType: first(rt.mealType, rt.meal_type, '') || '',
    // Precio de la estadía: total/amount/price directos, o suma de days {fecha: precio}.
    total: (() => { const n = Number(first(rt.total, rt.amount, rt.price, rt.value)); return isNaN(n) || n === 0 ? sumDays(rt.days) : n })(),
    perNight: (() => { const n = Number(first(rt.night, rt.nightly, rt.per_night, rt.rate)); return isNaN(n) ? null : n })(),
    available: (() => { const n = Number(first(rt.available, rt.allotment, rt.quantity, rt.stock)); return isNaN(n) ? null : n })(),
    raw: rt,
  }
}

const hosroom = {
  id: 'hosroom',
  label: 'HosRoom',
  defaultBaseUrl: 'https://sys.hosroom.com',

  async testConnection(cfg) {
    if (!cfg?.token) return { ok: false, message: 'Falta el token del hotel.' }
    // 1) /api/hotel valida que el token pertenezca a un HOTEL y da su nombre.
    let hotelName = ''
    try {
      const h = await hosFetch(cfg, '/api/hotel')
      hotelName = first(h?.data?.name, h?.name, '')
    } catch (e) {
      return { ok: false, message: e.message }
    }
    // 2) /api/engine/settings confirma que el "Motor de reservas" está habilitado.
    try {
      const data = await hosFetch(cfg, '/api/engine/settings')
      const root = data?.settings || data || {}
      const nRooms = arr(first(root.rooms, root.data, [])).length
      return { ok: true, message: `Conexión HosRoom OK${hotelName ? ` — ${hotelName}` : ''}${nRooms ? ` · ${nRooms} habitación(es)` : ''}`, hotelName }
    } catch (e) {
      return { ok: false, message: `Token del hotel válido${hotelName ? ` (${hotelName})` : ''}, pero el Motor de reservas no responde: ${e.message}` }
    }
  },

  // Habitaciones con ficha completa, fotos y planes.
  async getRooms(cfg) {
    const data = await hosFetch(cfg, '/api/engine/settings')
    const root = data?.settings || data || {}
    return arr(first(root.rooms, root.data, [])).map(normRoom)
  },

  // Disponibilidad por rango + ocupación. Laravel espera occupancy[adults]=N.
  async getAvailability(cfg, { checkin, checkout, adults, children, infants, rooms, promoCode, agencyCode }) {
    const query = {
      checkin, checkout,
      'occupancy[adults]': Math.max(1, Number(adults) || 1),
    }
    if (children) query['occupancy[children]'] = Number(children)
    if (infants) query['occupancy[infants]'] = Number(infants)
    if (rooms) query.rooms = Number(rooms)
    if (promoCode) query.promoCode = promoCode
    if (agencyCode) query.code = agencyCode
    const data = await hosFetch(cfg, '/api/engine/availability', { query })
    const root = data?.settings || data || {}
    const list = arr(first(root.rooms, root.availability, root.data, []))
    return { rooms: list.map(normRoom), raw: data }
  },

  // Crea la reserva. availability = { [rateId]: cantidad }.
  async book(cfg, { checkin, checkout, adults, children, infants, roomsCount, availability, customer, notes, promoCode, agencyCode, payment }) {
    const occupancy = { adults: Math.max(1, Number(adults) || 1) }
    if (children) occupancy.children = Number(children)
    if (infants) occupancy.infants = Number(infants)
    const body = {
      checkin, checkout, occupancy, availability,
      customer: {
        name: customer.name,
        surname: customer.surname || undefined,
        mail: customer.mail,
        phone: customer.phone,
      },
      source: 'bot',
    }
    if (roomsCount) body.rooms = Number(roomsCount)
    if (notes) body.notes = String(notes).slice(0, 500)
    if (promoCode) body.promoCode = promoCode
    if (agencyCode) body.code = agencyCode
    if (payment !== undefined) body.payment = !!payment
    const data = await hosFetch(cfg, '/api/engine/book', { method: 'POST', body })
    const d = data?.data || data || {}
    return {
      code: first(d.code, d.reference, ''),
      checkin: d.checkin, checkout: d.checkout,
      nights: d.nights,
      total: Number(first(d.total, d.amount, 0)) || 0,
      paymentUrl: first(d.payment?.url, ''),
      raw: d,
    }
  },

  // Estado/detalle de una reserva por su código HR-XXXX.
  async getBooking(cfg, code) {
    const data = await hosFetch(cfg, `/api/engine/status/${encodeURIComponent(code)}`)
    const d = data?.data || data || {}
    return {
      code: first(d.code, code),
      status: first(d.status, d.state, 'confirmada'),
      checkin: d.checkin, checkout: d.checkout, nights: d.nights,
      guestName: [d.customer?.name, d.customer?.surname].filter(Boolean).join(' '),
      total: Number(first(d.total, d.amount, 0)) || 0,
      paymentUrl: first(d.payment?.url, ''),
      raw: d,
    }
  },
}

// ── Kunas (OTASync) ────────────────────────────────────────────────────────────
// API tipo channel-manager: cada POST lleva { token, key, id_properties } en el
// cuerpo (no Bearer). Base real: https://app.hotelsync.com. Soporta crear, consultar
// y CANCELAR reservas de forma nativa. Precios por plan de tarifa + array de noches.
function datesOfStay(checkin, checkout) {
  const out = []; let d = checkin
  while (d < checkout) { out.push(d); d = addDays(d, 1) }
  return out
}
function normRoomKunas(rt) {
  return {
    id: String(first(rt.id_room_types, rt.id, '')),
    name: first(rt.name, rt.shortname, 'Habitación'),
    capacity: Number(first(rt.max_adults, rt.occupancy, rt.adults, 2)) || 2,
    description: first(rt.description, '') || '',
    photos: arr(first(rt.images, rt.gallery, rt.photos, [])).map(p => (typeof p === 'string' ? p : first(p.url, p.src, p.image, p.path))).filter(Boolean),
    basePrice: Number(first(rt.price, 0)) || 0,
    rates: [],
    raw: rt,
  }
}

const kunas = {
  id: 'kunas',
  label: 'Kunas',
  defaultBaseUrl: 'https://app.hotelsync.com',
  needsKey: true,   // la UI pide key (API key) + propertyId

  async _post(cfg, path, extra = {}) {
    const base = (cfg.baseUrl || this.defaultBaseUrl).replace(/\/$/, '')
    const body = { token: cfg.token, key: cfg.apiKey, id_properties: cfg.propertyId, ...extra }
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let data = null; try { data = text ? JSON.parse(text) : null } catch { data = text }
    const errMsg = data && typeof data === 'object' && (data.status === 'error' || data.error) ? (data.message || data.error) : null
    if (!res.ok || errMsg) {
      const raw = errMsg || (typeof data === 'string' ? data.slice(0, 200) : (data?.message || JSON.stringify(data || {}).slice(0, 200)))
      let msg = `Kunas ${res.status}: ${raw}`
      if (res.status === 401 || res.status === 403 || /unauth|invalid|token|key/i.test(String(raw))) {
        msg = 'Kunas: credenciales inválidas. Revisa el token, la key (API key) y el ID de propiedad.'
      }
      throw Object.assign(new Error(msg), { status: res.status })
    }
    return data
  },

  async testConnection(cfg) {
    if (!cfg?.token) return { ok: false, message: 'Falta el token de Kunas.' }
    if (!cfg?.apiKey || !cfg?.propertyId) return { ok: false, message: 'Kunas requiere la API key y el ID de propiedad (id_properties).' }
    const p = await this._post(cfg, '/api/property/data/property', {})
    const name = first(p?.name, p?.shortname, '')
    return { ok: true, message: `Conexión Kunas OK${name ? ` — ${name}` : ''}`, hotelName: name || '' }
  },

  async getRooms(cfg) {
    const data = await this._post(cfg, '/api/room/data/rooms', { type: 1, details: '1' })
    const list = Array.isArray(data) ? data : (data?.data || data?.rooms || [])
    return list.map(normRoomKunas)
  },

  // Resuelve el plan de tarifa a usar (configurado, o el primero con booking_engine).
  async _defaultPlan(cfg) {
    if (cfg.pricingPlanId) return cfg.pricingPlanId
    const plans = await this._post(cfg, '/api/pricingPlan/data/pricing_plans', {})
    const list = Array.isArray(plans) ? plans : (plans?.data || [])
    const be = list.find(p => String(p.booking_engine) === '1') || list[0]
    return be?.id_pricing_plans
  },

  async getAvailability(cfg, { checkin, checkout, adults, children }) {
    const plan = await this._defaultPlan(cfg)
    if (!plan) return { rooms: [] }
    // Habitaciones físicas libres por tipo.
    const av = await this._post(cfg, '/api/room/data/available_rooms', { dfrom: checkin, dto: checkout, id_pricing_plans: plan })
    const availList = arr(first(av?.rooms, av?.data, []))
    const freeByType = {}
    for (const r of availList) { const t = String(first(r.id_room_types, r.id_room_type, '')); (freeByType[t] ||= []).push(r) }
    // Precios por tipo y noche para el plan.
    let priceData = {}
    try { const pr = await this._post(cfg, '/api/prices/data/prices', { id_pricing_plans: plan, dfrom: checkin, dto: checkout }); priceData = pr?.data || {} } catch {}
    const nights = datesOfStay(checkin, checkout)
    // Fichas de habitación (nombre, capacidad, desc).
    let byId = {}
    try { const rooms = await this.getRooms(cfg); for (const rm of rooms) byId[rm.id] = rm } catch {}
    const out = []
    for (const [rtId, free] of Object.entries(freeByType)) {
      if (!free.length) continue
      const rm = byId[rtId] || { id: rtId, name: `Habitación ${rtId}`, capacity: 2, description: '', photos: [], basePrice: 0 }
      const perNightMap = priceData[rtId] || {}
      let total = 0, priced = true
      for (const d of nights) { const p = Number(perNightMap[d]); if (isNaN(p)) { priced = false; break } total += p }
      if (!priced || !total) total = (rm.basePrice || 0) * nights.length
      out.push({
        ...rm,
        rates: [{
          id: `${plan}:${rtId}`, name: rm.name, capacity: rm.capacity,
          total: total || null, perNight: nights.length ? (total / nights.length) : null,
          available: free.length, mealType: '',
          _plan: plan, _rtId: rtId, _room: free[0], _nightPrices: nights.map(d => ({ date: d, price: Number(perNightMap[d]) || (rm.basePrice || 0) })),
        }],
      })
    }
    return { rooms: out }
  },

  // Crea la reserva. availability = { "plan:rtId": 1 }. Reconstruye el detalle en vivo.
  async book(cfg, { checkin, checkout, adults, children, availability, customer }) {
    const rateId = Object.keys(availability || {})[0] || ''
    const [plan, rtId] = rateId.split(':')
    if (!plan || !rtId) throw new Error('Kunas: falta la tarifa/habitación a reservar.')
    // Re-verifica y toma la opción viva.
    const { rooms } = await this.getAvailability(cfg, { checkin, checkout, adults, children })
    const opt = rooms.map(r => r.rates[0]).find(rt => rt.id === rateId)
    if (!opt) throw new Error('La habitación elegida ya no está disponible para esas fechas.')
    const nights = opt._nightPrices
    const total = opt.total || nights.reduce((s, n) => s + (n.price || 0), 0)
    const avg = nights.length ? total / nights.length : total
    const room = opt._room || {}
    const roomName = opt.name
    const guestNames = String(customer.name || '').trim().split(/\s+/)
    const body = {
      status: 'confirmed',
      rooms: [{
        id_room_types: Number(rtId), id_rooms: first(room.id_rooms, room.id, undefined),
        room_type: roomName, room_number: first(room.name, room.room_number, ''),
        avg_price: avg, total_price: total,
        children_1: Number(children) || 0, children_2: 0, children_3: 0,
        adults: Math.max(1, Number(adults) || 1), seniors: 0,
        extras: [], payments: [], overbooking: 0,
        nights: nights.map(n => ({ night_date: n.date, price: n.price, original_price: n.price, breakfast: 0, lunch: 0, dinner: 0 })),
      }],
      guests: [{ first_name: guestNames[0] || 'Huésped', last_name: guestNames.slice(1).join(' ') || '', id_guests: 0, guest_type: 'adults', email: customer.mail || '', phone: customer.phone || '' }],
      extras: [], payments: [],
      adults: Math.max(1, Number(adults) || 1), children_1: Number(children) || 0, seniors: 0,
      rooms_price: total, rooms_discounted: total, total_price: total,
      id_pricing_plans: Number(plan),
    }
    const data = await this._post(cfg, '/api/reservation/insert/reservation', body)
    const r = data?.reservation || data || {}
    return {
      code: String(first(data?.id_reservations, r.id_reservations, '')),
      checkin: first(r.date_arrival, checkin), checkout: first(r.date_departure, checkout),
      nights: Number(first(r.nights, nights.length)),
      total: Number(first(r.total_price, total, 0)) || 0,
      paymentUrl: '',
      raw: r,
    }
  },

  async getBooking(cfg, code) {
    const data = await this._post(cfg, '/api/reservation/data/reservation', { id_reservations: code })
    const r = data?.reservation || data || {}
    const statusMap = { confirmed: 'confirmada', canceled: 'cancelada', cancelled: 'cancelada' }
    return {
      code: String(first(r.id_reservations, code)),
      status: statusMap[String(first(r.status, '')).toLowerCase()] || first(r.status, 'confirmada'),
      checkin: r.date_arrival, checkout: r.date_departure, nights: r.nights,
      guestName: first(r.guest_name, [r.first_name, r.last_name].filter(Boolean).join(' '), ''),
      total: Number(first(r.total_price, 0)) || 0,
      paymentUrl: '',
      raw: r,
    }
  },

  // Cancelación NATIVA (Kunas sí lo soporta).
  async cancel(cfg, code) {
    const data = await this._post(cfg, '/api/reservation/delete/delete', { id_reservations: code })
    const r = data?.reservation || data || {}
    return { ok: true, status: first(r.status, 'canceled'), code: String(first(r.id_reservations, code)) }
  },
}

const PROVIDERS = { hosroom, kunas }
function getProvider(id) { return PROVIDERS[id] || null }
function listProviders() { return Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, comingSoon: !!p.comingSoon })) }

module.exports = { getProvider, listProviders }
