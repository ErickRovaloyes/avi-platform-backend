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
 * Kunas (HotelSync) — integración REAL contra su API pública (spec en
 * https://api-docs.hotelsync.com/openapi.yaml). Base: https://app.hotelsync.com
 * (staging: https://beta.hotelsync.com). Todo es POST con JSON en el cuerpo.
 *
 * Tiene DOS mitades y conviene no confundirlas:
 *
 *   · MOTOR DE RESERVAS /api/engine/*  — PÚBLICO: solo pide `id_properties`. Es lo que usa
 *     el asistente: avail_and_prices (disponibilidad + precio por noche + min_stay),
 *     reservation_preview (cotización con impuestos), insert/reservation (crear),
 *     reservation_by_code (consultar) e insert/reservation_by_code (cancelar/reagendar).
 *     Al reservar por aquí no hace falta canal ni permisos, que era el origen del
 *     "Missing channel access rights for this user".
 *
 *   · GESTIÓN /api/{property,room,avail,calendar,channels}/* — exige login:
 *     POST /api/user/auth/login con {token, username, password} → `pkey`, que se manda
 *     como `key` en cada llamada junto al `token` de partner. El `token` lo da el soporte
 *     de HotelSync; el usuario y la contraseña son los de la propiedad.
 *
 * ⚠ `currency` NUNCA puede ir vacía: el motor cotiza TODO a 0 si lo está (comprobado).
 */

const first = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '')
const arr = x => (Array.isArray(x) ? x : (x ? [x] : []))
// Suma días a una fecha YYYY-MM-DD (usada por Kunas: rangos y disponibilidad).
function addDays(dateStr, n) { const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

// fetch con TIMEOUT (evita que una llamada al PMS se quede colgada y degrade el
// backend). Aborta a los `ms` y lanza un error claro.
async function tfetch(url, opts = {}, ms = 10000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctl.signal })
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('El PMS no respondió a tiempo (timeout).'), { status: 504 })
    throw e
  } finally { clearTimeout(t) }
}

// ── Transporte HosRoom ─────────────────────────────────────────────────────────
// La API de HosRoom usa Authorization: Bearer <token del hotel>. El token debe ser
// el del HOTEL (no el de un usuario) y el hotel debe tener habilitada la integración
// "Motor de reservas". Los mensajes de error traducen los casos típicos.
async function hosFetch(cfg, path, { method = 'GET', body, query, timeoutMs } = {}) {
  const base = (cfg.baseUrl || 'https://sys.hosroom.com').replace(/\/$/, '')
  const url = new URL(`${base}${path}`)
  for (const [k, v] of Object.entries(query || {})) { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)) }
  const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${cfg.token}` }
  if (body) headers['Content-Type'] = 'application/json'
  const res = await tfetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined }, timeoutMs)
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
function normRoom(r, base = 'https://sys.hosroom.com') {
  // Fotos tolerantes: 1) claves explícitas (preserva orden/portada), 2) deep-scan
  // (imagesOf) que captura la galería sea cual sea su forma. TODO se normaliza a URL
  // absoluta con la base de HosRoom (acepta rutas relativas). Antes solo miraba
  // r.gallery/photos/images de nivel raíz y no absolutizaba → se perdían las fotos.
  const explicit = arr(first(r.gallery, r.photos, r.images, r.pictures, r.photo, []))
    .map(p => (typeof p === 'string' ? p : first(p.url, p.src, p.original, p.large, p.medium, p.path, p.image, p.file, p.href)))
    .filter(Boolean)
    .map(u => absImg(u, base))
    .filter(Boolean)
  const photos = [...new Set([...explicit, ...imagesOf(r, base)])]
  return {
    id: String(first(r.id, r.room_id, r.code, '')),
    name: first(r.name, r.title, 'Habitación'),
    capacity: Number(first(r.capacity, r.max_occupancy, 2)),
    description: first(r.description, r.summary, ''),
    photos,
    rates: arr(first(r.rates, r.plans, r.ratePlans, r.rate_plans, r.tarifas, [])).map(normRate),
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

// ── Disponibilidad de HosRoom (/api/engine/availability) ──────────────────────
// La respuesta trae `results:[{ roomType:{id,name,capacity,description}, available,
// availabilityRates:[{ id, name, mealType, prices:{fecha:precio}, total, roomsAvailable }] }]`.
// Estructura DISTINTA a /api/engine/settings (ahí la habitación y sus rates van al nivel
// raíz), por eso necesita su propio normalizador.
function normAvailRate(rt) {
  const prices = (rt.prices && typeof rt.prices === 'object') ? Object.values(rt.prices).map(Number).filter(n => !isNaN(n)) : []
  const sumPrices = prices.length ? prices.reduce((a, b) => a + b, 0) : null
  const total = (() => { const n = Number(first(rt.total, rt.amount, rt.price, rt.value)); return (isNaN(n) || n === 0) ? sumPrices : n })()
  const perNight = (() => { const n = Number(first(rt.night, rt.nightly, rt.per_night, rt.rate)); if (!isNaN(n) && n) return n; return prices.length ? Math.round(sumPrices / prices.length) : null })()
  // Capacidad: del campo si viene; si no, se infiere del nombre del plan ("… 3 Personas").
  const capacity = (() => { const c = Number(first(rt.capacity, 0)); if (c) return c; const m = String(rt.name || '').match(/(\d+)\s*persona/i); return m ? Number(m[1]) : null })()
  const available = (() => { const n = Number(first(rt.roomsAvailable, rt.rooms_available, rt.available, rt.allotment, rt.quantity, rt.stock)); return isNaN(n) ? null : n })()
  return {
    id: String(first(rt.id, rt.rate_id, rt.rate_plan_id, '')),
    name: first(rt.name, rt.title, 'Tarifa'),
    capacity, description: first(rt.description, '') || '',
    mealType: first(rt.mealType, rt.meal_type, '') || '',
    total, perNight, available, raw: rt,
  }
}
function normAvailRoom(r, base = 'https://sys.hosroom.com') {
  const rt = r.roomType || r.room_type || r   // la habitación viene anidada en roomType
  const rates = arr(first(r.availabilityRates, r.availability_rates, r.rates, r.plans, r.ratePlans, r.rate_plans, r.tarifas, []))
  return {
    id: String(first(rt.id, rt.room_id, rt.code, r.id, '')),
    name: first(rt.name, rt.title, 'Habitación'),
    capacity: Number(first(rt.capacity, rt.max_occupancy, r.capacity, 2)),
    description: first(rt.description, rt.summary, '') || '',
    photos: imagesOf(rt, base),
    available: (() => { const n = Number(first(r.available, r.roomsAvailable, null)); return isNaN(n) ? null : n })(),
    rates: rates.map(normAvailRate),
    raw: r,
  }
}

// Caché corta del payload /api/engine/settings (es pesado, ~25 s): habitaciones y
// ficha de propiedad lo comparten para no pedirlo dos veces por operación.
const _hosSettingsCache = new Map()   // token|base → { at, data }
const HOS_SETTINGS_TTL = 60 * 1000
async function hosSettings(cfg) {
  const key = `${cfg.token}|${cfg.baseUrl || ''}`
  const hit = _hosSettingsCache.get(key)
  if (hit && Date.now() - hit.at < HOS_SETTINGS_TTL) return hit.data
  const data = await hosFetch(cfg, '/api/engine/settings', { timeoutMs: 25000 })
  _hosSettingsCache.set(key, { at: Date.now(), data })
  if (_hosSettingsCache.size > 200) { for (const [k, v] of _hosSettingsCache) if (Date.now() - v.at > HOS_SETTINGS_TTL) _hosSettingsCache.delete(k) }
  return data
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
      const data = await hosFetch(cfg, '/api/engine/settings', { timeoutMs: 25000 })
      const root = data?.settings || data || {}
      const nRooms = arr(first(root.rooms, root.data, [])).length
      return { ok: true, message: `Conexión HosRoom OK${hotelName ? ` — ${hotelName}` : ''}${nRooms ? ` · ${nRooms} habitación(es)` : ''}`, hotelName }
    } catch (e) {
      return { ok: false, message: `Token del hotel válido${hotelName ? ` (${hotelName})` : ''}, pero el Motor de reservas no responde: ${e.message}` }
    }
  },

  // Habitaciones con ficha completa, fotos y planes.
  // /api/engine/settings devuelve un payload ENORME (catálogo de amenidades), lento
  // de generar → timeout amplio (25 s). Se cachea 5 min (getRoomsCached).
  async getRooms(cfg) {
    const data = await hosSettings(cfg)
    const root = data?.settings || data || {}
    const base = cfg.baseUrl || 'https://sys.hosroom.com'
    return arr(first(root.rooms, root.data, [])).map(r => normRoom(r, base))
  },

  // Ficha del hotel + FOTOS del establecimiento (áreas comunes), del mismo
  // /api/engine/settings. Excluye las fotos que ya salen por habitación para no
  // duplicar. photoSkip descarta las primeras X (p.ej. si la 1ª es un logo/banner).
  async getProperty(cfg) {
    const base = cfg.baseUrl || 'https://sys.hosroom.com'
    const data = await hosSettings(cfg)
    const root = data?.settings || data || {}
    const hotel = root.hotel || root.property || root.establishment || root
    const rooms = arr(first(root.rooms, root.data, []))
    const roomPhotos = new Set(rooms.flatMap(r => imagesOf(r, base)))
    let photos = imagesOf(hotel, base).filter(u => !roomPhotos.has(u))
    const skip = Math.max(0, Number(cfg.photoSkip) || 0)
    if (skip) photos = photos.slice(skip)
    return {
      id: String(first(hotel.id, cfg.propertyId, 'default')),
      name: first(hotel.name, hotel.title, cfg.hotelName, ''),
      description: first(hotel.description, hotel.summary, '') || '',
      photos, raw: hotel,
    }
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
    // HosRoom devuelve las opciones en `results` (habitación en roomType + availabilityRates).
    const list = arr(first(root.results, root.rooms, root.availability, root.data, []))
    const base = cfg.baseUrl || 'https://sys.hosroom.com'
    return { rooms: list.map(r => normAvailRoom(r, base)), raw: data }
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
    // HosRoom lee `notes` SIEMPRE (acceso directo al array): hay que enviarlo aunque esté
    // vacío, o el book falla con 422 "Undefined array key notes".
    body.notes = notes ? String(notes).slice(0, 500) : ''
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

  // Diagnóstico: respuestas crudas para afinar el mapeo. Incluye una DISPONIBILIDAD
  // de ejemplo (2 noches desde mañana, 2 adultos) para ver dónde vienen precios/cupos.
  // Los campos "focalizados" (rooms+rates recortados) van PRIMERO para que sobrevivan
  // al recorte de tamaño del diagnóstico.
  async debug(cfg) {
    const out = {}
    const trimRooms = root => arr(first(root?.results, root?.rooms, root?.availability, root?.data, [])).map(r => {
      const rt = r.roomType || r.room_type || r
      const rates = arr(first(r.availabilityRates, r.availability_rates, r.rates, r.plans, r.ratePlans, r.rate_plans, r.tarifas, []))
      return {
        id: first(rt.id, rt.room_id, rt.code, r.id), name: first(rt.name, rt.title, r.name), capacity: first(rt.capacity, rt.max_occupancy, r.capacity),
        available: r.available,
        roomKeys: Object.keys(r || {}),
        photos: arr(first(rt.gallery, rt.photos, rt.images, r.gallery, r.photos, [])).length,
        ratesCount: rates.length,
        rateKeys: rates[0] ? Object.keys(rates[0]) : [],
        rates,
      }
    })
    try {
      const ci = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
      const co = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
      const av = await hosFetch(cfg, '/api/engine/availability', { query: { checkin: ci, checkout: co, 'occupancy[adults]': 2 } })
      const avRoot = av?.settings || av || {}
      out.availability = { checkin: ci, checkout: co, occupancyAdults: 2, topLevelKeys: Object.keys(avRoot), rooms: trimRooms(avRoot), raw: av }
    } catch (e) { out.availabilityError = e.message }
    try { const s = await hosFetch(cfg, '/api/engine/settings'); out.settingsRooms = trimRooms(s?.settings || s || {}) } catch (e) { out.settingsError = e.message }
    try { const h = await hosFetch(cfg, '/api/hotel'); out.hotel = first(h?.data?.name, h?.name, '(sin nombre)') } catch (e) { out.hotelError = e.message }
    return out
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
const _kunasLoginInflight = new Map() // token → Promise (single-flight: evita logins duplicados)
const _kunasRoomImgCache = new Map() // token:propId:rtId → { at, photos } (fotos propias del tipo de habitación)
const KUNAS_ROOMIMG_TTL = 10 * 60 * 1000
const _kunasChannelsCache = new Map() // token:propId → { at, channels } (canales de reserva)
const KUNAS_CHANNELS_TTL = 10 * 60 * 1000
// Motor de reservas (endpoints públicos /api/engine/*): ajustes y planes de tarifa por
// propiedad. Se cachean porque hacen falta en CADA búsqueda y cambian muy de vez en cuando.
const _kunasEngineCache = new Map() // propId:qué → { at, value }
const KUNAS_ENGINE_TTL = 10 * 60 * 1000
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
const IMG_KEY_RE = /(image|photo|foto|gallery|galer|img|media|picture|thumb|cover|banner|logo|avatar)/i
const IMG_EXT_RE = /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?\S*)?$/i
// Normaliza una posible URL de imagen a absoluta (acepta relativas //, /path, path).
// Devuelve null si no parece una imagen/URL utilizable.
function absImg(s, base = 'https://app.hotelsync.com') {
  s = String(s || '').trim()
  if (!s) return null
  const b = (base || '').replace(/\/$/, '')
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('//')) return 'https:' + s
  if (s.startsWith('/')) return b + s
  if (IMG_EXT_RE.test(s) || s.includes('/')) return b + '/' + s.replace(/^\/+/, '')
  return null
}
// Extrae URLs de imágenes de CUALQUIER forma de respuesta: recorre el objeto y
// captura strings que sean URL de imagen (por extensión o por ruta) o valores bajo
// claves tipo image/photo/foto/gallery/media…, normalizando a URL absoluta.
function imagesOf(o, base = 'https://app.hotelsync.com') {
  const raw = []
  const pushObj = el => {
    if (typeof el === 'string') raw.push(el)
    else if (el && typeof el === 'object') { const u = first(el.url, el.src, el.image, el.path, el.original, el.large, el.medium, el.file, el.filename, el.href); if (u) raw.push(u) }
  }
  const walk = (v, depth) => {
    if (v == null || depth > 6) return
    if (typeof v === 'string') { const s = v.trim(); const looksImg = IMG_EXT_RE.test(s) || /\/(images?|photos?|fotos?|uploads?|media|gallery|files?)\//i.test(s); if (looksImg && /^(https?:\/\/|\/\/|\/)/i.test(s)) raw.push(s); return }
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (IMG_KEY_RE.test(k)) {
          if (typeof val === 'string') String(val).split(/[,|;\n]/).forEach(s => { if (s.trim()) raw.push(s.trim()) })
          else if (Array.isArray(val)) { val.forEach(pushObj); val.forEach(x => walk(x, depth + 1)) }
          else { pushObj(val); walk(val, depth + 1) }
        } else walk(val, depth + 1)
      }
    }
  }
  walk(o, 0)
  // Excluye elementos que NO son fotos reales (íconos de UI, placeholders, banderas,
  // amenidades…). El LOGO no se filtra aquí: eso lo controla photoSkip por posición.
  const BAD = /(favicon|sprite|placeholder|no[-_]?image|noimage|not[-_]?found|blank|pixel|spacer|loader|loading|1x1|amenit|icon[s]?[\/._-]|\/flags?\/|default[-_.])/i
  return [...new Set(raw.map(s => absImg(s, base)).filter(Boolean))].filter(u => !BAD.test(u))
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
    const res = await tfetch(`${base}${path}`, {
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

  // Login con single-flight: si ya hay un login en curso para este token, reusa la
  // misma promesa (evita ráfagas de logins cuando varias vistas cargan a la vez).
  _login(cfg) {
    const inflight = _kunasLoginInflight.get(cfg.token)
    if (inflight) return inflight
    const p = this._loginImpl(cfg).finally(() => { _kunasLoginInflight.delete(cfg.token) })
    _kunasLoginInflight.set(cfg.token, p)
    return p
  },

  // Login real: con SOLO el token → la respuesta trae `pkey` (la api key para el
  // resto de endpoints) y el array `properties` (id_properties accesibles). Doc:
  // POST /api/user/auth/login. Captura la respuesta cruda para diagnosticar y, si
  // no aparece la pkey, lanza un error con lo que devolvió el API (no lo oculta).
  async _loginImpl(cfg) {
    const base = (cfg.baseUrl || this.defaultBaseUrl).replace(/\/$/, '')
    // El login exige token + usuario + contraseña (según la doc de Kunas).
    const loginBody = { token: cfg.token, remember: 1 }
    if (cfg.username) loginBody.username = cfg.username
    if (cfg.password) loginBody.password = cfg.password
    let diag = ''
    // Ruta única y documentada. Antes se probaban además /api/login/login y /api/auth/login,
    // que no existen: solo servían para tardar más y enturbiar el diagnóstico del fallo real.
    for (const path of ['/api/user/auth/login']) {
      let res, text
      try {
        res = await tfetch(`${base}${path}`, {
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

  // id_properties efectivo. Orden: el configurado a mano → el que trae el login.
  //
  // No existe endpoint para "listar mis propiedades": la única fuente documentada es la
  // respuesta del login (`properties[]`), que `_loginImpl` ya cachea. Antes se sondeaban
  // tres rutas que no existen en el API, y eso costaba tres viajes de ida y vuelta
  // fallidos en cada arranque en frío.
  //
  // Con `propertyId` configurado, TODO el flujo de reserva del huésped funciona SIN
  // credenciales, porque los endpoints del motor son públicos.
  async _propId(cfg) {
    if (cfg.propertyId) return String(cfg.propertyId)
    if (_kunasPropCache.has(cfg.token)) return _kunasPropCache.get(cfg.token)
    await this._key(cfg).catch(() => {})   // el login puebla la caché de propiedades
    if (_kunasPropCache.has(cfg.token)) return _kunasPropCache.get(cfg.token)
    throw new Error('Kunas: no se sabe qué propiedad usar. Escribe el ID de propiedad en la configuración del PMS, o revisa el token y el usuario (el login es lo que trae la lista de propiedades).')
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
    const properties = info.map(p => ({ id: String(p.id), name: p.name || `Propiedad ${p.id}` }))
    return { ok: true, message: `Conexión Kunas OK${name ? ` — ${name}` : ''}${extra}`, hotelName: name || '', propertyId, apiKey, properties }
  },

  // Propiedades accesibles (del login). Para elegir/filtrar en la UI.
  async listProperties(cfg) {
    if (_kunasPropInfo.has(cfg.token)) return _kunasPropInfo.get(cfg.token)
    await this._key(cfg, { forceLogin: true }).catch(() => {})
    return _kunasPropInfo.get(cfg.token) || []
  },

  // Calendario de una fecha: tipos de habitación con nombre/ocupación/precio/fotos.
  // El cuerpo pide explícitamente disponibilidad, precio y detalle (según la doc).
  async _calendar(cfg, date) {
    const body = { date, avail: 1, price: 1, min: 1, days: 1, scroll: 0 }
    if (cfg.pricingPlanId) body.id_pricing_plans = cfg.pricingPlanId
    if (cfg.restrictionPlanId) body.id_restriction_plans = cfg.restrictionPlanId
    return this._post(cfg, '/api/calendar/data/calendar', body)
  },
  // Mapea un room_type del calendario a la ficha normalizada (tolerante de campos).
  // Las fotos son SOLO las del alojamiento (propias o de sus habitaciones físicas
  // anidadas). NO se sustituyen por las de la propiedad (eso confundía las fotos).
  _mapRoomType(rt) {
    let photos = imagesOf(rt)
    for (const rm of (Array.isArray(rt.rooms) ? rt.rooms : [])) photos = photos.concat(imagesOf(rm))
    photos = [...new Set(photos)]
    return {
      id: String(first(rt.id_room_types, rt.id, rt.id_room_type, '')),
      name: first(rt.name, rt.shortname, rt.room_type, 'Habitación'),
      capacity: Number(first(rt.occupancy, rt.max_adults, rt.adults, rt.capacity, 2)) || 2,
      description: first(rt.description, rt.desc, '') || '',
      photos,
      basePrice: Number(first(rt.price, rt.base_price, rt.rate, 0)) || 0,
      rates: [],
    }
  },

  // FOTOS PROPIAS de un tipo de habitación: POST /api/room/data/room con el id_room_types.
  // Cada alojamiento tiene sus propias fotos (además de la galería de la propiedad madre);
  // aquí se traen las suyas (roomDetails.images[].url). Se cachea 10 min por propiedad+tipo.
  // Se llama de forma PEREZOSA (solo cuando el asistente va a enviar fotos), no en getRooms.
  async getRoomPhotos(cfg, roomTypeId) {
    if (!roomTypeId) return []
    const propId = await this._propId(cfg)
    const ck = `${cfg.token}:${propId}:${roomTypeId}`
    const hit = _kunasRoomImgCache.get(ck)
    if (hit && Date.now() - hit.at < KUNAS_ROOMIMG_TTL) return hit.photos
    try {
      const data = await this._post(cfg, '/api/room/data/room', { id_room_types: Number(roomTypeId) || roomTypeId })
      const rd = data?.roomDetails || data?.data?.roomDetails || {}
      const imgs = Array.isArray(rd.images) ? rd.images : []
      const photos = [...new Set(
        imgs.map(im => (typeof im === 'string' ? im : first(im.url, im.src, im.image, im.path)))
          .map(u => absImg(u, cfg.baseUrl))
          .filter(Boolean)
      )]
      _kunasRoomImgCache.set(ck, { at: Date.now(), photos })
      return photos
    } catch { return [] }
  },

  // Datos de la propiedad + sus FOTOS: /api/property/data/property.
  // PRECISO: las fotos reales están en property.images[].url. El logo (engine_logo)
  // es un campo aparte y NO se incluye. photoSkip descarta las primeras X.
  async getProperty(cfg) {
    const data = await this._post(cfg, '/api/property/data/property', {})
    const p = (data && typeof data === 'object' && !Array.isArray(data)) ? (data.property || data.data || data) : {}
    let photos = (Array.isArray(p.images) ? p.images : [])
      .map(im => (typeof im === 'string' ? im : first(im.url, im.src, im.image, im.path, im.original)))
      .filter(Boolean)
    // Respaldo tolerante si no vino el array images (otra forma), SIN logos.
    if (!photos.length) photos = imagesOf(data, cfg.baseUrl).filter(u => !/logo|favicon/i.test(u))
    const skip = Math.max(0, Number(cfg.photoSkip) || 0)
    if (skip) photos = photos.slice(skip)
    return {
      id: String(first(p.id_properties, p.id, '')),
      name: first(p.name, p.shortname, cfg.hotelName, ''),
      description: first(p.description, p.desc, '') || '',
      photos,
      raw: p,
    }
  },

  // Habitaciones (tipos). Primero por el calendario, que es lo único que trae las FOTOS
  // propias de cada tipo; si no hay credenciales (o el login falla) se caen al motor, que
  // es público y da nombre, descripción y capacidad. Así "ver habitaciones" nunca se queda
  // en blanco solo porque falte el token de gestión.
  async getRooms(cfg) {
    const date = new Date().toISOString().slice(0, 10)
    try {
      const data = await this._calendar(cfg, date)
      const list = deepFindArray(data, 'room_types') || (Array.isArray(data) ? data : arr(first(data?.data, data?.rooms, [])))
      const rooms = (list || []).map(rt => this._mapRoomType(rt)).filter(r => r.id || r.name)
      if (rooms.length) return rooms
    } catch (e) { /* sin credenciales de gestión: se usa el motor */ }
    return this._roomsFromEngine(cfg, date)
  },

  // Tipos de habitación deducidos del motor (público). Se piden 30 días para que no
  // desaparezca un tipo solo porque hoy esté lleno.
  async _roomsFromEngine(cfg, date) {
    const cur = await this._currency(cfg)
    const plans = await this._pricingPlans(cfg)
    if (!plans.length) return []
    const d = await this._engine(cfg, '/api/engine/data/avail_and_prices', {
      id_pricing_plans: Number(plans[0].id) || plans[0].id, currency: cur,
      dfrom: date, dto: addDays(date, 30), guests: { adults: 2, children_1: 0 },
    })
    const list = Array.isArray(d) ? d : arr(first(d?.data, d?.rooms, []))
    return list.map(rt => {
      const prices = arr(rt.dates).map(x => Number(x.price)).filter(n => n > 0)
      return {
        id: String(first(rt.id_room_types, rt.id, '')),
        name: first(rt.name, 'Habitación'),
        capacity: Number(first(rt.max_adults, rt.occupancy, 2)) || 2,
        description: first(rt.description, '') || '',
        photos: [],
        basePrice: prices.length ? Math.min(...prices) : 0,
        rates: [],
        raw: rt,
      }
    }).filter(r => r.id)
  },

  // Disponibilidad real por rango: /api/avail/data/avail → { roomTypeId: { fecha: cupo } }.
  async _avail(cfg, dfrom, dto) {
    const data = await this._post(cfg, '/api/avail/data/avail', { dfrom, dto })
    // Puede venir plano o bajo data. Normaliza a { rtId: { fecha: cupo } }.
    const root = (data && typeof data === 'object' && !Array.isArray(data)) ? (data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data) : {}
    const map = {}
    for (const [rtId, byDate] of Object.entries(root)) {
      if (!byDate || typeof byDate !== 'object' || Array.isArray(byDate)) continue
      const inner = {}
      for (const [d, c] of Object.entries(byDate)) { if (/^\d{4}-\d{2}-\d{2}/.test(d)) inner[d.slice(0, 10)] = Number(c) || 0 }
      if (Object.keys(inner).length) map[String(rtId)] = inner
    }
    return map
  },

  // ── Motor de reservas (/api/engine/*) ────────────────────────────────────────
  // Son endpoints PÚBLICOS: solo piden id_properties, sin login ni token de partner. Es la
  // vía correcta para lo que hace el asistente (buscar, cotizar y reservar como reserva
  // directa) y además evita el "Missing channel access rights for this user" que devuelve
  // la API de gestión, porque no se imputa a un canal ni depende de permisos del usuario.
  async _engine(cfg, path, body = {}) {
    const propId = await this._propId(cfg)
    return this._rawFetch(cfg, path, { id_properties: propId, id_language: cfg.language || '', ...body })
  },

  async _engineCached(cfg, what, fn) {
    const propId = await this._propId(cfg)
    const ck = `${propId}:${what}`
    const hit = _kunasEngineCache.get(ck)
    if (hit && Date.now() - hit.at < KUNAS_ENGINE_TTL) return hit.value
    const value = await fn.call(this)
    _kunasEngineCache.set(ck, { at: Date.now(), value })
    return value
  },

  // Ajustes públicos de la propiedad (horas de check-in/out, moneda, si exige tarjeta).
  async _settings(cfg) {
    return this._engineCached(cfg, 'settings', async () => {
      const d = await this._engine(cfg, '/api/engine/data/settings', {})
      return d?.settings || d || {}
    })
  },

  // Moneda efectiva. CRÍTICO: si se envía vacía, el motor cotiza TODO a 0 (comprobado
  // contra el API: con currency:"" el preview devuelve total_price 0; con "EUR", 450).
  // Por eso nunca se deja vacía: config → ajustes de la propiedad → EUR.
  async _currency(cfg) {
    if (cfg.currency) return String(cfg.currency)
    try { const s = await this._settings(cfg); if (s.currency) return String(s.currency) } catch {}
    return 'EUR'
  },

  // Planes de tarifa: cada uno es una OPCIÓN reservable (régimen y política distintos).
  async _pricingPlans(cfg) {
    return this._engineCached(cfg, 'plans', async () => {
      const cur = await this._currency(cfg)
      const d = await this._engine(cfg, '/api/engine/data/pricing_plans', { currency: cur })
      const list = Array.isArray(d) ? d : arr(first(d?.pricing_plans, d?.data, []))
      return list.map(p => ({
        id: String(first(p.id_pricing_plans, p.id, '')),
        name: first(p.name, 'Tarifa'),
        board: first(p.board_name, ''),
        policy: first(p.policy_name, ''),
        policyText: first(p.policy_description, ''),
      })).filter(p => p.id)
    })
  },

  // Disponibilidad + precios REALES por noche, del motor. Una llamada por plan de tarifa,
  // así el cliente ve opciones de verdad ("Doble · Desayuno — 450 €") en vez de una sola
  // tarifa calculada a partir de un precio base que casi siempre llegaba en 0.
  async getAvailability(cfg, { checkin, checkout, adults, children }) {
    const nights = datesOfStay(checkin, checkout)
    const cur = await this._currency(cfg)
    let plans = await this._pricingPlans(cfg)
    if (cfg.pricingPlanId) {
      const only = plans.filter(p => p.id === String(cfg.pricingPlanId))
      if (only.length) plans = only
    }
    if (!plans.length) plans = [{ id: String(cfg.pricingPlanId || ''), name: 'Tarifa', board: '', policy: '' }]
    const guests = { adults: Math.max(1, Number(adults) || 1), children_1: Number(children) || 0 }

    // Como mucho 6 planes: más opciones no ayudan a decidir y multiplican las llamadas
    // en una conversación que el cliente está esperando.
    const results = await Promise.all(plans.slice(0, 6).map(async plan => {
      try {
        const d = await this._engine(cfg, '/api/engine/data/avail_and_prices', {
          id_pricing_plans: Number(plan.id) || plan.id, currency: cur, dfrom: checkin, dto: checkout, guests,
        })
        return { plan, list: Array.isArray(d) ? d : arr(first(d?.data, d?.rooms, [])) }
      } catch { return { plan, list: [] } }
    }))

    // Se agrupa por tipo de habitación; cada plan aporta una tarifa a esa habitación.
    const byRoom = new Map()
    for (const { plan, list } of results) {
      for (const rt of list) {
        const rtId = String(first(rt.id_room_types, rt.id, ''))
        if (!rtId) continue
        const dates = arr(rt.dates).filter(d => nights.includes(String(d.date).slice(0, 10)))
        if (!dates.length) continue
        // Cupo del rango = el de la noche más justa. Una noche cerrada invalida la estancia.
        let minAvail = Infinity, total = 0, closed = false, minStay = 0
        for (const d of dates) {
          const av = Number(d.avail); minAvail = Math.min(minAvail, isNaN(av) ? 0 : av)
          total += Number(d.price) || 0
          if (Number(d.closed)) closed = true
          minStay = Math.max(minStay, Number(d.min_stay) || 0)
        }
        if (!isFinite(minAvail)) minAvail = 0
        // El motor rechazaría la reserva igualmente: descartarlo aquí evita que el
        // asistente ofrezca —y prometa— una estancia que luego no se puede crear.
        if (closed || dates.length < nights.length) continue
        if (minStay && nights.length < minStay) continue

        if (!byRoom.has(rtId)) {
          byRoom.set(rtId, {
            id: rtId,
            name: first(rt.name, `Habitación ${rtId}`),
            capacity: Number(first(rt.max_adults, rt.occupancy, 2)) || 2,
            description: first(rt.description, '') || '',
            photos: [], basePrice: 0, rates: [],
          })
        }
        const room = byRoom.get(rtId)
        if (!room.basePrice && dates[0]) room.basePrice = Number(dates[0].price) || 0
        room.rates.push({
          id: `${plan.id}:${rtId}`,
          name: [plan.name, plan.board].filter(Boolean).join(' · ') || room.name,
          capacity: room.capacity,
          total: total || null,
          perNight: dates.length ? Math.round((total / dates.length) * 100) / 100 : null,
          available: minAvail,
          mealType: /break|desayun|bb/i.test(plan.board) ? 'breakfast' : '',
          policy: plan.policy,
          _rtId: rtId, _planId: plan.id, _room: rt,
          _nightPrices: dates.map(d => ({ date: String(d.date).slice(0, 10), price: Number(d.price) || 0 })),
        })
      }
    }
    return { rooms: [...byRoom.values()].filter(r => r.rates.length) }
  },

  // Disponibilidad de todo un rango en UNA sola llamada (para el heatmap del calendario).
  async getMonthAvailability(cfg, { dfrom, dto }) {
    return this._avail(cfg, dfrom, dto)   // { rtId: { fecha: cupo } }
  },

  // Diagnóstico: respuestas crudas para afinar el mapeo cuando algo no cuadra.
  // Se sondean SOLO endpoints que existen. Antes probaba seis rutas de las que cinco no
  // existen en el API, así que el diagnóstico salía lleno de errores que no significaban nada.
  async debug(cfg) {
    const out = { properties: _kunasPropInfo.get(cfg.token) || [] }
    const date = new Date().toISOString().slice(0, 10)
    const dto = addDays(date, 7)
    // Motor de reservas: es lo que usa el asistente, así que es lo primero que interesa ver.
    try { out.engineSettings = await this._settings(cfg) } catch (e) { out.engineSettingsError = e.message }
    try { out.enginePlans = await this._pricingPlans(cfg) } catch (e) { out.enginePlansError = e.message }
    try { out.engineAvail = await this.getAvailability(cfg, { checkin: date, checkout: dto, adults: 2, children: 0 }) } catch (e) { out.engineAvailError = e.message }
    // Lado de gestión (este sí exige login con token + usuario + contraseña).
    try { out.property = await this._post(cfg, '/api/property/data/property', {}) } catch (e) { out.propertyError = e.message }
    try { out.calendar = await this._calendar(cfg, date) } catch (e) { out.calendarError = e.message }
    try { out.avail = await this._post(cfg, '/api/avail/data/avail', { dfrom: date, dto }) } catch (e) { out.availError = e.message }
    try { out.channels = await this.getChannels(cfg) } catch (e) { out.channelsError = e.message }
    return out
  },

  // Canales de reserva de la propiedad (/api/channels/data/channels). Solo informativo: el
  // asistente ya NO imputa las reservas a un canal (las crea por el motor), que era justo
  // lo que provocaba el "Missing channel access rights for this user".
  async getChannels(cfg) {
    const propId = await this._propId(cfg)
    const ck = `${cfg.token}:${propId}`
    const hit = _kunasChannelsCache.get(ck)
    if (hit && Date.now() - hit.at < KUNAS_CHANNELS_TTL) return hit.channels
    let channels = []
    try {
      const data = await this._post(cfg, '/api/channels/data/channels', {})
      const list = Array.isArray(data) ? data : arr(first(data?.data, data?.channels, []))
      channels = list
        .map(c => ({ id: String(first(c.id_channels, c.id, '')), name: first(c.name, ''), type: first(c.type, '') }))
        .filter(c => c.id)
      _kunasChannelsCache.set(ck, { at: Date.now(), channels })
    } catch {}
    return channels
  },

  // "planId:rtId" → sus dos partes. Acepta el formato antiguo (solo rtId) para no romper
  // una conversación en curso que ya había ofrecido opciones con el id viejo.
  _splitRate(cfg, rateId) {
    const s = String(rateId || '')
    const colon = s.indexOf(':')
    return {
      rtId: colon >= 0 ? s.slice(colon + 1) : s,
      planId: colon >= 0 ? s.slice(0, colon) : (cfg.pricingPlanId || ''),
    }
  },

  _guest(customer = {}) {
    const parts = String(customer.name || '').trim().split(/\s+/)
    return {
      first_name: parts[0] || 'Huésped',
      last_name: customer.surname || parts.slice(1).join(' ') || '',
      email: customer.mail || '', phone: customer.phone || '',
      address: '', city: '', country: '',
    }
  },

  // Cotización oficial ANTES de reservar: el motor devuelve el desglose real (habitación,
  // tasa turística, extras, impuestos). Sirve para no prometerle al cliente un total que
  // luego no cuadre con lo que le cobra el hotel.
  async quote(cfg, { checkin, checkout, adults, children, rateId, customer = {} }) {
    const { rtId, planId } = this._splitRate(cfg, rateId)
    const cur = await this._currency(cfg)
    const d = await this._engine(cfg, '/api/engine/data/reservation_preview', {
      currency: cur,
      date_arrival: checkin, date_departure: checkout,
      id_pricing_plans: Number(planId) || planId,
      adults: String(Math.max(1, Number(adults) || 1)),
      children_1: String(Number(children) || 0), children_2: '0', children_3: '0',
      occupancy: Math.max(1, Number(adults) || 1) + (Number(children) || 0),
      rooms: [{ id_room_types: Number(rtId) || rtId }],
      guests: [this._guest(customer)],
      extras: [],
    })
    return {
      total: Number(d?.total_price) || 0,
      rooms: Number(d?.rooms_price) || 0,
      cityTax: Number(d?.city_tax_price) || 0,
      extras: Number(d?.extras_price) || 0,
      currency: d?.currency || cur,
      nights: Number(d?.nights) || datesOfStay(checkin, checkout).length,
      raw: d,
    }
  },

  // Crea la reserva por el MOTOR (/api/engine/insert/reservation).
  // availability = { "planId:rtId": 1 }.
  //
  // A diferencia de la API de gestión que se usaba antes, aquí `rooms` es solo
  // [{ id_room_types }]: el precio lo calcula el motor desde el plan de tarifa. Eso quita
  // de encima dos problemas reales: no se puede reservar a un precio distinto del que el
  // hotel tiene publicado, y desaparece el "Missing channel access rights for this user"
  // (la reserva entra como reserva directa del motor, sin depender de permisos de canal).
  async book(cfg, { checkin, checkout, adults, children, availability, customer = {}, notes, promoCode }) {
    const rateId = Object.keys(availability || {})[0] || ''
    if (!rateId) throw new Error('Kunas: falta la tarifa/habitación a reservar.')
    const { rtId, planId } = this._splitRate(cfg, rateId)
    if (!rtId) throw new Error('Kunas: falta la habitación a reservar.')

    // Se revalida contra el motor: entre que se ofreció la opción y el cliente dijo que sí,
    // pueden haber vendido la última habitación.
    const { rooms } = await this.getAvailability(cfg, { checkin, checkout, adults, children })
    const allRates = rooms.flatMap(r => r.rates)
    const opt = allRates.find(rt => rt.id === rateId) || allRates.find(rt => String(rt._rtId) === String(rtId))
    if (!opt) throw new Error('La habitación elegida ya no está disponible para esas fechas.')

    const cur = await this._currency(cfg)
    const data = await this._engine(cfg, '/api/engine/insert/reservation', {
      currency: cur,
      date_arrival: checkin, date_departure: checkout,
      id_pricing_plans: Number(planId) || planId,
      rooms: [{ id_room_types: Number(rtId) || rtId }],
      guests: [this._guest(customer)],
      extras: [],
      adults: String(Math.max(1, Number(adults) || 1)),
      children_1: String(Number(children) || 0), children_2: '0', children_3: '0',
      ...(notes ? { note: String(notes).slice(0, 500) } : {}),
      ...(promoCode ? { id_promocodes: String(promoCode) } : {}),
    })
    const r = data?.reservation || data || {}
    // El motor identifica la reserva por CÓDIGO: es lo que el huésped usa después para
    // consultarla o cancelarla, no el id interno.
    const code = String(first(r.code, r.reservation_code, data?.code, r.id_reservations, ''))
    return {
      code,
      checkin: first(r.date_arrival, checkin), checkout: first(r.date_departure, checkout),
      nights: Number(first(r.nights, opt._nightPrices.length)),
      total: Number(first(r.total_price, opt.total, 0)) || 0,
      paymentUrl: first(r.payment_url, r.paymentUrl, ''),
      raw: r,
    }
  },

  async getBooking(cfg, code) {
    const data = await this._engine(cfg, '/api/engine/data/reservation_by_code', { code: String(code) })
    const r = data?.reservation || data || {}
    // El motor responde 200 con cuerpo vacío cuando el código no existe: sin esto, el
    // asistente le confirmaría al cliente una reserva fantasma con todos los campos vacíos.
    if (!r || (!r.date_arrival && !r.code && !r.id_reservations)) {
      throw Object.assign(new Error('Reserva no encontrada'), { status: 404 })
    }
    const statusMap = { confirmed: 'confirmada', canceled: 'cancelada', cancelled: 'cancelada', pending: 'pendiente' }
    return {
      code: String(first(r.code, r.id_reservations, code)),
      status: statusMap[String(first(r.status, '')).toLowerCase()] || first(r.status, 'confirmada'),
      checkin: r.date_arrival, checkout: r.date_departure,
      nights: Number(first(r.nights, datesOfStay(r.date_arrival, r.date_departure).length)) || undefined,
      guestName: first(r.guest_name, [r.first_name, r.last_name].filter(Boolean).join(' ').trim(), ''),
      total: Number(first(r.total_price, 0)) || 0,
      paymentUrl: '',
      raw: r,
    }
  },

  // Cancelación por código, por el mismo motor con el que se creó.
  async cancel(cfg, code) {
    const data = await this._engine(cfg, '/api/engine/insert/reservation_by_code', {
      code: String(code), status: 'canceled',
    })
    const r = data?.reservation || data || {}
    return { ok: true, status: first(r.status, 'canceled'), code: String(first(r.code, code)) }
  },

  // Reagendar: cambia las fechas de una reserva existente por su código. Antes comprueba
  // que las fechas nuevas tengan hueco, para no dejar la reserva a medio cambiar.
  async reschedule(cfg, code, { checkin, checkout }) {
    const current = await this.getBooking(cfg, code)
    const { rooms } = await this.getAvailability(cfg, { checkin, checkout, adults: 1, children: 0 })
    if (!rooms.length) throw new Error('No hay disponibilidad en las fechas nuevas.')
    const data = await this._engine(cfg, '/api/engine/insert/reservation_by_code', {
      code: String(code), date_arrival: checkin, date_departure: checkout,
      currency: await this._currency(cfg),
    })
    const r = data?.reservation || data || {}
    return {
      ok: true, code: String(first(r.code, code)),
      checkin: first(r.date_arrival, checkin), checkout: first(r.date_departure, checkout),
      total: Number(first(r.total_price, current.total, 0)) || 0,
    }
  },
}

const octorate = require('./pmsOctorate')
const PROVIDERS = { hosroom, kunas, octorate }
function getProvider(id) { return PROVIDERS[id] || null }
function listProviders() { return Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, comingSoon: !!p.comingSoon })) }

module.exports = { getProvider, listProviders }
