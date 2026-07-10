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
    const data = await hosFetch(cfg, '/api/engine/settings', { timeoutMs: 25000 })
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

  // Diagnóstico: respuestas crudas para afinar el mapeo.
  async debug(cfg) {
    const out = {}
    try { out.settings = await hosFetch(cfg, '/api/engine/settings') } catch (e) { out.settingsError = e.message }
    try { out.hotel = await hosFetch(cfg, '/api/hotel') } catch (e) { out.hotelError = e.message }
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
    if (typeof v === 'string') { const s = v.trim(); if (/^https?:\/\//i.test(s) && (IMG_EXT_RE.test(s) || /\/(images?|photos?|fotos?|uploads?|media|gallery|files?)\//i.test(s))) raw.push(s); return }
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (IMG_KEY_RE.test(k)) {
          if (typeof val === 'string') String(val).split(/[,|;\n]/).forEach(s => { if (s.trim()) raw.push(s.trim()) })
          else if (Array.isArray(val)) val.forEach(pushObj)
          else pushObj(val)
        } else walk(val, depth + 1)
      }
    }
  }
  walk(o, 0)
  const b = (base || 'https://app.hotelsync.com').replace(/\/$/, '')
  const norm = s => {
    s = String(s || '').trim()
    if (!s) return null
    if (/^https?:\/\//i.test(s)) return s
    if (s.startsWith('//')) return 'https:' + s
    if (s.startsWith('/')) return b + s
    if (IMG_EXT_RE.test(s) || s.includes('/')) return b + '/' + s.replace(/^\/+/, '')
    return null
  }
  // Excluye elementos que NO son fotos reales (íconos de UI, placeholders, banderas,
  // amenidades…). El LOGO no se filtra aquí: eso lo controla photoSkip por posición.
  const BAD = /(favicon|sprite|placeholder|no[-_]?image|noimage|not[-_]?found|blank|pixel|spacer|loader|loading|1x1|amenit|icon[s]?[\/._-]|\/flags?\/|default[-_.])/i
  return [...new Set(raw.map(norm).filter(Boolean))].filter(u => !BAD.test(u))
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
    for (const path of ['/api/user/auth/login', '/api/login/login', '/api/auth/login']) {
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

  // Habitaciones (tipos) desde el calendario, con SUS fotos propias.
  async getRooms(cfg) {
    const date = new Date().toISOString().slice(0, 10)
    const data = await this._calendar(cfg, date)
    const list = deepFindArray(data, 'room_types') || (Array.isArray(data) ? data : arr(first(data?.data, data?.rooms, [])))
    return (list || []).map(rt => this._mapRoomType(rt)).filter(r => r.id || r.name)
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

  async getAvailability(cfg, { checkin, checkout }) {
    const map = await this._avail(cfg, checkin, checkout)
    const nights = datesOfStay(checkin, checkout)
    let byId = {}
    try { const rooms = await this.getRooms(cfg); for (const rm of rooms) byId[rm.id] = rm } catch {}
    const out = []
    for (const [rtId, byDate] of Object.entries(map)) {
      let minAvail = Infinity
      for (const d of nights) { const c = Number(byDate[d]); minAvail = Math.min(minAvail, isNaN(c) ? 0 : c) }
      if (!isFinite(minAvail)) minAvail = 0
      const rm = byId[String(rtId)] || { id: String(rtId), name: `Habitación ${rtId}`, capacity: 2, description: '', photos: [], basePrice: 0 }
      const total = (rm.basePrice || 0) * nights.length
      out.push({
        ...rm,
        rates: [{ id: String(rtId), name: rm.name, capacity: rm.capacity, total: total || null, perNight: rm.basePrice || null, available: minAvail, mealType: '', _rtId: rtId, _room: {}, _nightPrices: nights.map(d => ({ date: d, price: rm.basePrice || 0 })) }],
      })
    }
    return { rooms: out }
  },

  // Disponibilidad de todo un rango en UNA sola llamada (para el heatmap del calendario).
  async getMonthAvailability(cfg, { dfrom, dto }) {
    return this._avail(cfg, dfrom, dto)   // { rtId: { fecha: cupo } }
  },

  // Diagnóstico: respuestas crudas para afinar el mapeo cuando algo no cuadra.
  async debug(cfg) {
    const out = { properties: _kunasPropInfo.get(cfg.token) || [] }
    const date = new Date().toISOString().slice(0, 10)
    const dto = addDays(date, 7)
    try { out.property = await this._post(cfg, '/api/property/data/property', {}) } catch (e) { out.propertyError = e.message }
    try { out.calendar = await this._calendar(cfg, date) } catch (e) { out.calendarError = e.message }
    try { out.avail = await this._post(cfg, '/api/avail/data/avail', { dfrom: date, dto }) } catch (e) { out.availError = e.message }
    return out
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
