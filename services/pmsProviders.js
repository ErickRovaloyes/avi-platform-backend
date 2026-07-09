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
// El usuario solo pega el TOKEN. La key (pKey) se obtiene haciendo login con el
// token, y el id_properties se auto-descubre. Ambos se cachean por token.
const _kunasKeyCache = new Map()    // token → pKey (api key)
const _kunasPropCache = new Map()   // token → id_properties (primera propiedad)
const _kunasPropInfo = new Map()    // token → [{id, name}] (del login)
// Busca recursivamente una clave (pkey/apikey…) en la respuesta del login.
function deepFind(obj, names, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null
  for (const k of Object.keys(obj)) {
    if (names.includes(k.toLowerCase()) && obj[k] && typeof obj[k] !== 'object') return String(obj[k])
  }
  for (const k of Object.keys(obj)) { const r = deepFind(obj[k], names, depth + 1); if (r) return r }
  return null
}
// Busca recursivamente un array con cierto nombre (properties) en la respuesta.
function deepFindArray(obj, name, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null
  for (const k of Object.keys(obj)) { if (k.toLowerCase() === name && Array.isArray(obj[k])) return obj[k] }
  for (const k of Object.keys(obj)) { const r = deepFindArray(obj[k], name, depth + 1); if (r) return r }
  return null
}
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
  // Solo pide el TOKEN: la key (pKey) se obtiene por login y el id_properties se auto-descubre.

  // Fetch de bajo nivel: envía EXACTAMENTE el cuerpo dado (para el login, que solo lleva token).
  async _rawFetch(cfg, path, body) {
    const base = (cfg.baseUrl || this.defaultBaseUrl).replace(/\/$/, '')
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    const text = await res.text()
    let data = null; try { data = text ? JSON.parse(text) : null } catch { data = text }
    const errMsg = data && typeof data === 'object' && (data.status === 'error' || data.error) ? (data.message || data.error) : null
    if (!res.ok || errMsg) {
      const raw = errMsg || (typeof data === 'string' ? data.slice(0, 200) : (data?.message || JSON.stringify(data || {}).slice(0, 200)))
      let msg = `Kunas ${res.status}: ${raw}`
      if (res.status === 401 || res.status === 403 || /unauth|invalid|token|key/i.test(String(raw))) {
        msg = 'Kunas: el token es inválido o expiró. Reinicia las credenciales y pega el token vigente que te da Kunas.'
      }
      throw Object.assign(new Error(msg), { status: res.status })
    }
    return data
  },

  // Login: con SOLO el token → la respuesta trae `pkey` (la api key para el resto
  // de endpoints) y el array `properties` (id_properties accesibles). Doc oficial:
  // POST /api/user/auth/login. Captura la respuesta cruda para diagnosticar y, si
  // no aparece la pkey, lanza un error con lo que devolvió el API (no lo oculta).
  async _login(cfg) {
    const base = (cfg.baseUrl || this.defaultBaseUrl).replace(/\/$/, '')
    // El login exige token + usuario + contraseña (según la doc de Kunas).
    const loginBody = { token: cfg.token, remember: 1 }
    if (cfg.username) loginBody.username = cfg.username
    if (cfg.password) loginBody.password = cfg.password
    let diag = ''
    for (const path of ['/api/user/auth/login', '/api/login/login', '/api/auth/login']) {
      let res, text
      try {
        res = await fetch(`${base}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(loginBody),
        })
        text = await res.text()
      } catch (e) { diag = `${path} → red: ${e.message}`; continue }
      let data = null; try { data = text ? JSON.parse(text) : null } catch { data = text }
      const pKey = deepFind(data, ['pkey', 'apikey', 'api_key', 'key'])
      if (pKey) {
        // La respuesta del login también trae las propiedades accesibles.
        const propsArr = deepFindArray(data, 'properties') || []
        const props = propsArr
          .map(p => ({ id: String(first(p.id_properties, p.id, p.property_id, '')), name: first(p.name, p.shortname, '') }))
          .filter(p => p.id)
        if (props.length) {
          _kunasPropInfo.set(cfg.token, props)
          if (!_kunasPropCache.has(cfg.token)) _kunasPropCache.set(cfg.token, props[0].id)
        }
        _kunasKeyCache.set(cfg.token, pKey)
        return pKey
      }
      // Sin pkey → guarda qué devolvió (mensaje de negocio o snippet) para el diagnóstico.
      const biz = data && typeof data === 'object' ? (data.message || data.error || (data.errors && JSON.stringify(data.errors)) || data.status) : null
      const snippet = biz ? String(biz).slice(0, 160) : (typeof data === 'string' ? data.slice(0, 160) : JSON.stringify(data || {}).slice(0, 160))
      diag = `${path} → HTTP ${res.status} · ${snippet}`
      // 404 = ruta equivocada, sigue probando; cualquier otra respuesta ya es la real.
      if (res.status !== 404) break
    }
    throw Object.assign(new Error(`Kunas: el login no devolvió la key (pkey). El API respondió: ${diag || 'sin datos'}`), { noPkey: true })
  },

  // Key efectiva (pKey). Prioridad: caché en memoria → guardada → login por token.
  // `_login` lanza un error descriptivo si no logra la key (no devuelve vacío).
  async _key(cfg, { forceLogin = false } = {}) {
    if (!forceLogin) {
      if (_kunasKeyCache.has(cfg.token)) return _kunasKeyCache.get(cfg.token)
      if (cfg.apiKey) { _kunasKeyCache.set(cfg.token, cfg.apiKey); return cfg.apiKey }
    }
    return this._login(cfg)   // cachea internamente al obtener la pkey
  },

  // POST autenticado (token + key resuelta). Reintenta con login fresco si la key expiró.
  async _rawPost(cfg, path, body = {}, _retried = false) {
    const key = await this._key(cfg)
    if (!key) throw Object.assign(new Error('Kunas: no se pudo iniciar sesión con el token (no se obtuvo la key/pKey).'), { status: 401 })
    try {
      return await this._rawFetch(cfg, path, { token: cfg.token, key, ...body })
    } catch (e) {
      if ((e.status === 401 || e.status === 403) && !_retried) {
        _kunasKeyCache.delete(cfg.token)
        const fresh = await this._key(cfg, { forceLogin: true }).catch(() => '')
        if (fresh) return this._rawFetch(cfg, path, { token: cfg.token, key: fresh, ...body })
      }
      throw e
    }
  },

  // Auto-descubre el id_properties (el usuario no lo escribe).
  async _discoverProperty(cfg) {
    for (const path of ['/api/property/data/properties', '/api/properties/data/properties', '/api/property/data/property_list']) {
      try {
        const data = await this._rawPost(cfg, path, {})
        const list = Array.isArray(data) ? data : arr(first(data?.data, data?.properties, data?.property, []))
        const p = list[0] || (data && typeof data === 'object' && !Array.isArray(data) ? data : null)
        const id = first(p?.id_properties, p?.id, p?.property_id)
        if (id) return { id: String(id), name: first(p?.name, p?.shortname, '') }
      } catch (e) { if (e.status === 401 || e.status === 403) throw e }
    }
    return null
  },

  // id_properties efectivo: el configurado, o el del login (o descubrimiento explícito).
  async _propId(cfg) {
    if (cfg.propertyId) return cfg.propertyId
    if (_kunasPropCache.has(cfg.token)) return _kunasPropCache.get(cfg.token)
    // El login ya trae las propiedades: forzarlo puebla la caché.
    await this._key(cfg).catch(() => {})
    if (_kunasPropCache.has(cfg.token)) return _kunasPropCache.get(cfg.token)
    const found = await this._discoverProperty(cfg)
    if (found?.id) { _kunasPropCache.set(cfg.token, found.id); return found.id }
    return ''
  },

  // POST autenticado que siempre incluye el id_properties resuelto.
  async _post(cfg, path, extra = {}) {
    const id_properties = await this._propId(cfg)
    return this._rawPost(cfg, path, { id_properties, ...extra })
  },

  async testConnection(cfg) {
    if (!cfg?.token) return { ok: false, message: 'Falta el token de Kunas.' }
    // 1) Login con el token → key (pkey) + propiedades (en la misma respuesta).
    let apiKey = ''
    try { apiKey = await this._key(cfg, { forceLogin: true }) }
    catch (e) { return { ok: false, message: e.message } }
    if (!apiKey) return { ok: false, message: 'Kunas: el token no permitió iniciar sesión (no llegó la key/pkey). Verifica que sea el token vigente de Kunas.' }
    // 2) Propiedad: la del login (o la configurada).
    const info = _kunasPropInfo.get(cfg.token) || []
    let propertyId = cfg.propertyId || (info[0]?.id) || _kunasPropCache.get(cfg.token) || ''
    if (!propertyId) return { ok: false, message: 'Kunas: el token inició sesión pero no trae ninguna propiedad asociada. Verifica que la cuenta tenga una propiedad activa.' }
    _kunasPropCache.set(cfg.token, propertyId)
    let name = info.find(p => p.id === propertyId)?.name || info[0]?.name || ''
    if (!name) {
      try { const p = await this._rawPost(cfg, '/api/property/data/property', { id_properties: propertyId }); name = first(p?.name, p?.shortname, '') } catch {}
    }
    const extra = info.length > 1 ? ` (${info.length} propiedades; usando "${name || propertyId}")` : ''
    return { ok: true, message: `Conexión Kunas OK${name ? ` — ${name}` : ''}${extra}`, hotelName: name || '', propertyId, apiKey }
  },

  // Propiedades accesibles (del login). Para elegir/filtrar en la UI.
  async listProperties(cfg) {
    if (_kunasPropInfo.has(cfg.token)) return _kunasPropInfo.get(cfg.token)
    await this._key(cfg, { forceLogin: true }).catch(() => {})
    return _kunasPropInfo.get(cfg.token) || []
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
