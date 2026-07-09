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

// Kunas: en la lista de proveedores; se activa cuando tengamos su documentación.
const kunas = {
  id: 'kunas',
  label: 'Kunas',
  comingSoon: true,
  defaultBaseUrl: '',
  async testConnection() { return { ok: false, message: 'Kunas estará disponible próximamente. Por ahora usa HosRoom.' } },
  async getRooms() { throw new Error('Kunas aún no está disponible.') },
  async getAvailability() { throw new Error('Kunas aún no está disponible.') },
  async book() { throw new Error('Kunas aún no está disponible.') },
  async getBooking() { throw new Error('Kunas aún no está disponible.') },
}

const PROVIDERS = { hosroom, kunas }
function getProvider(id) { return PROVIDERS[id] || null }
function listProviders() { return Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, comingSoon: !!p.comingSoon })) }

module.exports = { getProvider, listProviders }
