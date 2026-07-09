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
 * Autenticación: el token de API se canjea por una SESIÓN de hotel (cookie) vía
 * POST /login-api (HosRoom NO usa Authorization: Bearer). Base: https://sys.hosroom.com
 * NOTA: el engine NO expone cancelar/reagendar; esas operaciones van como
 * "solicitud gestionada" (nota interna + aviso al equipo) desde services/pms.js.
 *
 * Kunas — en la lista, pendiente de documentación oficial (mismo contrato).
 */

const first = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '')
const arr = x => (Array.isArray(x) ? x : (x ? [x] : []))

// ── Sesión HosRoom ─────────────────────────────────────────────────────────────
// HosRoom NO usa Authorization: Bearer. El token de API se canjea por una SESIÓN
// de hotel (cookie) haciendo POST a /login-api; luego el resto de endpoints
// (/api/engine/*) se llaman con esa cookie. Cacheamos la sesión por token (~45 min)
// y re-logueamos si expira (401).
const _sessions = new Map() // token → { at, cookies }
const SESSION_TTL = 45 * 60 * 1000

function parseSetCookies(res) {
  const out = {}
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : [])
  for (const line of list) {
    const m = /^\s*([^=;]+)=([^;]*)/.exec(line)
    if (m) out[m[1].trim()] = m[2]
  }
  return out
}
const cookieHeader = c => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ')

async function hosLogin(base, token) {
  // 1) GET /login-api → CSRF (_token) + cookies iniciales.
  const g = await fetch(`${base}/login-api`, { headers: { 'Accept': 'text/html' } })
  const html = await g.text()
  let cookies = parseSetCookies(g)
  const m = /name="_token"\s+value="([^"]+)"/.exec(html) || /<meta name="csrf-token" content="([^"]+)"/.exec(html)
  const csrf = m ? m[1] : ''
  // 2) POST el token → establece la sesión de hotel (302 en éxito, 401/422 si es inválido).
  const p = await fetch(`${base}/login-api`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/html', 'Cookie': cookieHeader(cookies) },
    body: new URLSearchParams({ _token: csrf, token }).toString(),
  })
  cookies = { ...cookies, ...parseSetCookies(p) }
  if (p.status === 401 || p.status === 419 || p.status === 422) {
    throw Object.assign(new Error('HosRoom: el token de API es inválido o expiró. Genéralo de nuevo en HosRoom.'), { status: 401 })
  }
  if (!cookies.hosroom_session) throw new Error('HosRoom: no se pudo iniciar la sesión con el token.')
  return cookies
}

async function hosSession(cfg, force = false) {
  const base = (cfg.baseUrl || 'https://sys.hosroom.com').replace(/\/$/, '')
  const hit = _sessions.get(cfg.token)
  if (!force && hit && Date.now() - hit.at < SESSION_TTL) return { base, entry: hit }
  const cookies = await hosLogin(base, cfg.token)
  const entry = { at: Date.now(), cookies }
  _sessions.set(cfg.token, entry)
  return { base, entry }
}

// Llamada autenticada a la API de HosRoom con la sesión (cookie). Reintenta una vez
// re-logueando si la sesión caducó.
async function hosFetch(cfg, path, { method = 'GET', body, query, _retry = false } = {}) {
  const { base, entry } = await hosSession(cfg)
  const url = new URL(`${base}${path}`)
  for (const [k, v] of Object.entries(query || {})) { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)) }
  const headers = { 'Accept': 'application/json', 'Cookie': cookieHeader(entry.cookies) }
  if (body) headers['Content-Type'] = 'application/json'
  if (entry.cookies['XSRF-TOKEN']) headers['X-XSRF-TOKEN'] = decodeURIComponent(entry.cookies['XSRF-TOKEN'])
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  // Mantén la sesión fresca (Laravel rota XSRF-TOKEN por request).
  const fresh = parseSetCookies(res)
  if (Object.keys(fresh).length) entry.cookies = { ...entry.cookies, ...fresh }
  const text = await res.text()
  let data = null; try { data = text ? JSON.parse(text) : null } catch { data = text }
  if ((res.status === 401 || res.status === 419) && !_retry) {
    _sessions.delete(cfg.token)
    return hosFetch(cfg, path, { method, body, query, _retry: true })
  }
  if (!res.ok) {
    const msg = typeof data === 'string' ? data.slice(0, 200) : (data?.message || JSON.stringify(data?.errors || data || {}).slice(0, 200))
    throw Object.assign(new Error(`HosRoom ${res.status}: ${msg}`), { status: res.status })
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
    try {
      const data = await hosFetch(cfg, '/api/engine/settings')
      const root = data?.settings || data || {}
      const name = first(root.hotel?.name, root.hotel?.title, data?.hotel?.name, '')
      const nRooms = arr(first(root.rooms, root.data, [])).length
      return { ok: true, message: `Conexión HosRoom OK${name ? ` — ${name}` : ''}${nRooms ? ` · ${nRooms} habitación(es)` : ''}`, hotelName: name || '' }
    } catch (e) {
      return { ok: false, message: e.message }
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
