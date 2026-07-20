'use strict'
/**
 * Herramienta IA Especial "PMS" (HosRoom / Kunas).
 * El asistente puede: ver habitaciones (con fotos reales), consultar disponibilidad
 * con cotización, reservar (con link de pago), ver el estado de una reserva y
 * solicitar reagendas/cancelaciones (gestionadas: nota interna + aviso al equipo,
 * porque el Booking Engine de HosRoom no expone esos endpoints todavía).
 *
 * Config por cuenta en accounts.pms (JSON):
 *   { provider, token, baseUrl, currency, maxPhotos, notifyTeam, postBookingFlowId }
 * Patrón idéntico a services/scheduling.js: todo corre en el servidor.
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const providers = require('./pmsProviders')
const socket = require('./socket')

// ── Config por cuenta ──────────────────────────────────────────────────────────
async function loadConfig(accId) {
  try { const [[a]] = await pool.query('SELECT pms FROM accounts WHERE id=?', [accId]); return parseJ(a?.pms, null) }
  catch { return null }
}
async function saveConfig(accId, cfg) { await pool.query('UPDATE accounts SET pms=? WHERE id=?', [JSON.stringify(cfg || {}), accId]) }

// Config pública (sin credenciales) — va dentro de account.pms para el runtime/UI.
function publicConfig(cfg) {
  const c = cfg || {}
  const prov = providers.getProvider(c.provider)
  // HosRoom: solo el token (Bearer). Kunas: token + (usuario+contraseña para el
  // primer login, o la key/pKey ya derivada). El resto se resuelve por detrás.
  const hasCreds = c.provider === 'kunas'
    ? !!(c.token && (c.apiKey || (c.username && c.password)))
    : !!c.token
  const connected = !!(c.provider && prov && !prov.comingSoon && hasCreds)
  const blockedProps = (Array.isArray(c.blockedProperties) ? c.blockedProperties : []).map(String)
  const allProps = Array.isArray(c.properties) ? c.properties.map(p => ({ id: String(p.id), name: p.name || `Propiedad ${p.id}` })) : []
  const props = allProps.filter(p => !blockedProps.includes(p.id))   // solo NO bloqueadas para la IA
  return {
    connected,
    provider: c.provider || '',
    providerLabel: prov?.label || '',
    hotelName: c.hotelName || '',
    currency: c.currency || 'COP',
    maxPhotos: Number(c.maxPhotos) || 4,
    photoSkip: Math.max(0, Number(c.photoSkip) || 0),
    properties: props,
    multiProperty: props.length > 1,
  }
}

async function testConnection(accId) {
  const cfg = await loadConfig(accId)
  if (!cfg?.provider) return { ok: false, message: 'Elige un proveedor y guarda el token.' }
  const prov = providers.getProvider(cfg.provider)
  if (!prov) return { ok: false, message: `Proveedor desconocido: ${cfg.provider}` }
  const r = await prov.testConnection(cfg)
  // Guarda lo auto-resuelto (Kunas: key derivada del login + id de propiedad + la
  // LISTA de propiedades; y el nombre del hotel) para mostrarlo en la UI y evitar
  // rehacer login en cada llamada (conexión estable, sin re-login).
  if (r.ok && (r.hotelName || r.propertyId || r.apiKey || r.properties)) {
    await saveConfig(accId, {
      ...cfg,
      hotelName: r.hotelName || cfg.hotelName,
      propertyId: r.propertyId || cfg.propertyId,
      apiKey: r.apiKey || cfg.apiKey,
      properties: (Array.isArray(r.properties) && r.properties.length) ? r.properties : cfg.properties,
    }).catch(() => {})
  }
  return r
}

// ── Cachés en memoria ──────────────────────────────────────────────────────────
// Habitaciones: 5 min por cuenta (la disponibilidad NUNCA se cachea). Si la llamada
// FALLA (p.ej. HosRoom no responde), se cachea el fallo 30 s para NO repetir esperas
// largas (evita que el modelo reintente y acumule timeouts).
const _roomsCache = new Map()   // accId:propId → { at, rooms } | { at, error }
const ROOMS_TTL = 5 * 60 * 1000
const ROOMS_ERR_TTL = 30 * 1000
// Últimas opciones de disponibilidad por conversación (para reservar por número).
const _optionsCache = new Map() // convId → { at, checkin, checkout, adults, children, options: [{n, rateId, roomName, rateName, total}] }
const OPTIONS_TTL = 20 * 60 * 1000

async function getRoomsCached(accId, cfg) {
  const ck = `${accId}:${cfg.propertyId || 'default'}`
  const hit = _roomsCache.get(ck)
  if (hit && Date.now() - hit.at < (hit.error ? ROOMS_ERR_TTL : ROOMS_TTL)) {
    if (hit.error) throw hit.error
    return hit.rooms
  }
  const prov = providers.getProvider(cfg.provider)
  try {
    const rooms = await prov.getRooms(cfg)
    _roomsCache.set(ck, { at: Date.now(), rooms })
    return rooms
  } catch (e) {
    _roomsCache.set(ck, { at: Date.now(), error: e })   // fallo cacheado 30 s → falla rápido
    throw e
  }
}

// Ficha de la propiedad (con FOTOS) cacheada por cuenta+propiedad.
const _propCache = new Map()   // accId:propertyId → { at, property }
async function getPropertyCached(accId, cfg) {
  const prov = providers.getProvider(cfg.provider)
  if (!prov || typeof prov.getProperty !== 'function') return null
  const ck = `${accId}:${cfg.propertyId || 'default'}`
  const hit = _propCache.get(ck)
  if (hit && Date.now() - hit.at < (hit.property ? ROOMS_TTL : ROOMS_ERR_TTL)) return hit.property
  const property = await prov.getProperty(cfg).catch(() => null)
  _propCache.set(ck, { at: Date.now(), property })
  return property
}

// ── Cursor de fotos ya enviadas (para no repetir al pedir "más fotos") ──────────
// Por conversación + propiedad + (habitación | 'all'). En memoria, con TTL/cap.
const _photoSent = new Map()   // key → { at, urls:Set }
const PHOTO_TTL = 60 * 60 * 1000
function photoKey(convId, propId, roomId) { return `${convId || '-'}:${propId || 'default'}:${roomId || 'all'}` }
function photoState(key, reset) {
  let st = _photoSent.get(key)
  if (reset || !st || Date.now() - st.at > PHOTO_TTL) { st = { at: Date.now(), urls: new Set() }; _photoSent.set(key, st) }
  st.at = Date.now()
  if (_photoSent.size > 3000) { for (const [k, v] of _photoSent) if (Date.now() - v.at > PHOTO_TTL) _photoSent.delete(k) }
  return st
}
// Envía el siguiente lote de fotos NO enviadas. Al agotarse, avisa y reinicia el
// cursor para poder reenviar desde el principio si el cliente lo pide.
function sendPhotoBatch(pool, key, { maxPhotos, reset, label, extra }) {
  pool = [...new Set((pool || []).filter(Boolean))]
  if (!pool.length) return { text: `No hay fotos publicadas${label ? ` de ${label}` : ''} en el PMS.${extra ? `\n${extra}` : ''}` }
  const st = photoState(key, reset)
  const fresh = pool.filter(u => !st.urls.has(u))
  if (!fresh.length) {
    _photoSent.set(key, { at: Date.now(), urls: new Set() })   // reinicia para reenviar desde el principio
    return { text: `Ya te envié todas las fotos disponibles${label ? ` de ${label}` : ''} (${pool.length} en total) y no hay más nuevas. Dile al cliente que, si quiere, se las puedes reenviar desde el principio (vuelve a llamar ver_habitaciones con desde_inicio=true).` }
  }
  const batch = fresh.slice(0, Math.max(1, maxPhotos || 4))
  batch.forEach(u => st.urls.add(u))
  const media = batch.map((url, i) => ({ url, caption: i === 0 && label ? label : '' }))
  const firstBatch = st.urls.size === batch.length
  const remaining = pool.length - st.urls.size
  const head = firstBatch ? `Envié ${media.length} foto(s)${label ? ` de ${label}` : ''} al cliente.` : `Envié ${media.length} foto(s) MÁS${label ? ` de ${label}` : ''} (distintas a las anteriores).`
  const tail = remaining > 0 ? ` Quedan ${remaining} foto(s) más si el cliente quiere ver otras.` : ` Con estas ya se enviaron todas las fotos disponibles.`
  return { text: `${head}${tail}${extra ? `\n${extra}` : ''}`, media }
}

// Bloqueo: propiedad completa o alojamiento (habitación) dentro de una propiedad.
const roomBlockKey = (propId, roomId) => `${propId || 'default'}::${roomId}`
function isRoomBlocked(cfg, propId, roomId) {
  return (Array.isArray(cfg.blockedRooms) ? cfg.blockedRooms : []).includes(roomBlockKey(propId, roomId))
}
function filterBlockedRooms(cfg, propId, rooms) {
  return (rooms || []).filter(r => !isRoomBlocked(cfg, propId, r.id))
}

// Resuelve la propiedad indicada por el asistente (nombre o id) contra la lista
// del login (excluyendo las BLOQUEADAS). Devuelve el cfg con esa propiedad, o null.
function resolveProperty(cfg, propArg) {
  const blocked = (Array.isArray(cfg.blockedProperties) ? cfg.blockedProperties : []).map(String)
  const props = (Array.isArray(cfg.properties) ? cfg.properties : []).filter(p => !blocked.includes(String(p.id)))
  if (!propArg || props.length <= 1) return { id: props[0]?.id || cfg.propertyId, name: cfg.hotelName || (props[0]?.name || ''), cfg: props[0]?.id ? { ...cfg, propertyId: String(props[0].id) } : cfg }
  const q = norm(propArg)
  const p = props.find(x => norm(x.name) === q)
    || props.find(x => norm(x.name).includes(q) || q.includes(norm(x.name)))
    || props.find(x => String(x.id) === String(propArg).trim())
  if (!p) return null
  return { id: String(p.id), name: p.name, cfg: { ...cfg, propertyId: String(p.id) } }
}

// ── Utilidades ─────────────────────────────────────────────────────────────────
function fmtMoney(n, currency) {
  if (n == null || isNaN(n)) return null
  try { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: currency || 'COP', maximumFractionDigits: 0 }).format(n) }
  catch { return `${Math.round(n).toLocaleString('es-CO')} ${currency || ''}`.trim() }
}
function nightsBetween(checkin, checkout) {
  const a = new Date(`${checkin}T12:00:00Z`), b = new Date(`${checkout}T12:00:00Z`)
  return Math.max(1, Math.round((b - a) / 86400000))
}
function addDays(dateStr, n) { const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim())
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Identidad del huésped desde la conversación (nombre, teléfono, email).
async function guestIdentity(accId, convId) {
  if (!convId) return { name: '', phone: '', email: '' }
  try {
    const [[c]] = await pool.query('SELECT guest_name, wa_from, local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!c) return { name: '', phone: '', email: '' }
    const lv = parseJ(c.local_vars, {})
    let email = ''
    for (const [k, v] of Object.entries(lv)) {
      if (typeof v !== 'string') continue
      if (/mail|correo/i.test(k) && /.+@.+\..+/.test(v)) { email = v.trim(); break }
      if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) email = v.trim()
    }
    let phone = c.wa_from || ''
    if (!phone) { for (const [k, v] of Object.entries(lv)) { if (/tel|phone|cel|whats/i.test(k) && String(v).replace(/\D/g, '').length >= 7) { phone = String(v).trim(); break } } }
    const name = (c.guest_name && !/^(Visitante|Guest|WA #|FB #|IG #)/i.test(c.guest_name)) ? c.guest_name : (lv.nombre || lv.name || c.guest_name || '')
    return { name: String(name || '').trim(), phone: String(phone || '').trim(), email }
  } catch { return { name: '', phone: '', email: '' } }
}

// Nota interna para el equipo + marca la conversación como no leída.
// Solo escribe si convId es una conversación REAL de la cuenta (evita que el
// proxy público inyecte notas/spam en el inbox con un convId arbitrario).
async function internalNote(accId, agId, convId, content) {
  try {
    if (!convId) return
    const [[c]] = await pool.query('SELECT id FROM conversations WHERE id=? AND account_id=? LIMIT 1', [convId, accId])
    if (!c) return
    await pool.query('INSERT INTO crm_notes (id,account_id,target_type,target_id,author_id,author_name,content,ts) VALUES (?,?,?,?,?,?,?,?)',
      ['note_' + uid(), accId, 'conversation', convId, 'pms', 'Asistente PMS', String(content || '').slice(0, 600), Date.now()])
    await pool.query('UPDATE conversations SET unread=1, unread_count=unread_count+1 WHERE id=? AND account_id=?', [convId, accId])
    socket.emit(accId, 'convos:updated', { accId, agId })
  } catch {}
}

// Registro en CRM: crea el contacto si no existe (no crítico).
async function upsertCrmContact(accId, { name, phone, email }, extraInfo) {
  try {
    if (!phone && !email) return
    const [[found]] = await pool.query(
      'SELECT id, extra FROM contacts WHERE account_id=? AND ((phone<>"" AND phone=?) OR (email<>"" AND email=?)) LIMIT 1',
      [accId, phone || '·', email || '·']
    )
    if (found) {
      const extra = parseJ(found.extra, {})
      const tags = Array.isArray(extra.tags) ? extra.tags : []
      if (!tags.includes('hotel')) tags.push('hotel')
      extra.tags = tags
      extra.lastPmsBooking = extraInfo || extra.lastPmsBooking
      await pool.query('UPDATE contacts SET extra=? WHERE id=?', [JSON.stringify(extra), found.id])
      return found.id
    }
    const id = 'ct_' + uid()
    await pool.query('INSERT INTO contacts (id,account_id,name,email,phone,extra,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, accId, name || 'Huésped', email || '', phone || '', JSON.stringify({ tags: ['hotel'], source: 'pms', lastPmsBooking: extraInfo || '' }), Date.now()])
    return id
  } catch { return null }
}

// ── Formateo de disponibilidad → opciones numeradas ────────────────────────────
function buildOptions(availRooms, { adults, children }) {
  const wanted = (Number(adults) || 1) + (Number(children) || 0)
  const options = []
  for (const room of availRooms) {
    for (const rate of (room.rates || [])) {
      // Si la tarifa declara capacidad, respeta el tamaño del grupo.
      if (rate.capacity && rate.capacity < Math.min(wanted, room.capacity || wanted)) continue
      options.push({ rateId: rate.id, roomId: room.id, roomName: room.name, rateName: rate.name, mealType: rate.mealType, total: rate.total, perNight: rate.perNight, capacity: rate.capacity || room.capacity })
    }
  }
  // Más baratas primero (sin precio al final).
  options.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity))
  return options.map((o, i) => ({ n: i + 1, ...o }))
}

function optionsText(options, { checkin, checkout, currency }) {
  const nights = nightsBetween(checkin, checkout)
  const lines = options.slice(0, 8).map(o => {
    const price = o.total != null ? `${fmtMoney(o.total, currency)} total (${nights} noche${nights === 1 ? '' : 's'})`
      : (o.perNight != null ? `${fmtMoney(o.perNight, currency)}/noche` : 'precio según tarifa')
    const meal = o.mealType === 'breakfast' ? ' · incluye desayuno' : ''
    return `Opción ${o.n}: ${o.roomName} — ${o.rateName}${meal} — ${price}`
  })
  return lines.join('\n')
}

// ── Despachador de funciones del asistente ─────────────────────────────────────
async function toolCall(accId, fn, args = {}, { convId, agId } = {}) {
  const cfg = await loadConfig(accId)
  const pub = publicConfig(cfg)
  if (!pub.connected) return { text: 'El PMS no está conectado. El equipo debe configurarlo en Zona IA → PMS.' }
  const prov = providers.getProvider(cfg.provider)
  const currency = pub.currency
  const props = pub.properties        // ya excluye las propiedades BLOQUEADAS
  const multi = pub.multiProperty

  // ── Ver propiedades (hoteles del grupo, p.ej. Kunas multi-propiedad) ──────
  if (fn === 'ver_propiedades') {
    if (!multi) return { text: `Este alojamiento tiene una sola propiedad${cfg.hotelName ? `: ${cfg.hotelName}` : ''}. Muestra sus habitaciones con ver_habitaciones.` }
    return { text: `Propiedades disponibles (${props.length}):\n${props.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}\n\nPregúntale al cliente en cuál está interesado y pásala como "propiedad" (el nombre) a ver_habitaciones, ver_disponibilidad_hotel o reservar_habitacion.` }
  }

  // Multi-propiedad: para operar hay que fijar la propiedad. Si no la indican, la pide.
  let scoped = cfg
  if (multi && ['ver_habitaciones', 'ver_disponibilidad_hotel', 'reservar_habitacion'].includes(fn)) {
    if (!args.propiedad) return { text: `Este hotel maneja varias propiedades: ${props.map(p => p.name).join(', ')}. Pregúntale al cliente en cuál desea y vuelve a llamar con "propiedad": <nombre>.` }
    const r = resolveProperty(cfg, args.propiedad)
    if (!r) return { text: `No reconocí la propiedad "${args.propiedad}". Disponibles: ${props.map(p => p.name).join(', ')}.` }
    scoped = r.cfg
  }

  // ── Ver habitaciones ──────────────────────────────────────────────────────
  // POR DEFECTO devuelve la LISTA en texto (nombre, capacidad y descripción) para que
  // el asistente enumere las habitaciones. Solo envía FOTOS si el cliente las pide:
  // "habitacion"=<nombre> (fotos+ficha de una) o "fotos"=true (panorama). Cada envío
  // de fotos manda fotos NUEVAS; desde_inicio=true reenvía desde el principio.
  if (fn === 'ver_habitaciones') {
    const [roomsAll, property] = await Promise.all([
      getRoomsCached(accId, scoped),
      getPropertyCached(accId, scoped).catch(() => null),
    ])
    const rooms = filterBlockedRooms(cfg, scoped.propertyId, roomsAll)   // oculta alojamientos bloqueados
    const propPhotos = (property?.photos || []).filter(Boolean)
    const propName = property?.name || cfg.hotelName || ''
    const reset = args.desde_inicio === true || /^(true|1|si|sí)$/i.test(String(args.desde_inicio || ''))
    const wantPhotos = args.fotos === true || /^(true|1|si|sí)$/i.test(String(args.fotos || '')) || reset
    const maxPhotos = pub.maxPhotos

    const wanted = norm(args.habitacion || '')
    if (wanted && rooms.length) {
      const room = rooms.find(r => norm(r.name).includes(wanted) || wanted.includes(norm(r.name))) ||
        rooms.find(r => norm(r.name).split(/\s+/).some(w => wanted.includes(w) && w.length > 3))
      if (!room) return { text: `No encontré una habitación llamada "${args.habitacion}". Las disponibles son: ${rooms.map(r => r.name).join(', ')}.` }
      const plans = (room.rates || []).map(rt => `• ${rt.name}${rt.mealType === 'breakfast' ? ' (con desayuno)' : ''}`).join('\n')
      const ficha = `Ficha: capacidad ${room.capacity} persona(s). ${room.description || ''}${plans ? `\nPlanes: \n${plans}` : ''}`
      // Fotos del alojamiento: sus propias fotos (otros PMS) o la galería de SU
      // propiedad (Kunas no da fotos por room_type; la galería es de la propiedad).
      const roomPool = room.photos?.length ? room.photos : propPhotos
      if (!roomPool.length) return { text: `No hay fotos publicadas para "${room.name}" en el PMS. ${ficha}` }
      return sendPhotoBatch(roomPool, photoKey(convId, scoped.propertyId, room.id), { maxPhotos, reset, label: room.name, extra: ficha })
    }

    // Sin habitación concreta.
    if (!rooms.length) return { text: property?.description ? `${propName}${propName ? ': ' : ''}${property.description}` : 'El PMS no devolvió habitaciones para esta propiedad.' }
    const list = rooms.map(r => `• ${r.name} — capacidad ${r.capacity} persona(s)${r.description ? ` — ${String(r.description).slice(0, 160)}` : ''}`).join('\n')
    // Por defecto: LISTA en texto (no spamear fotos cuando solo preguntan qué hay).
    if (!wantPhotos) {
      return { text: `Habitaciones${propName ? ` de ${propName}` : ''}:\n${list}\n\nEnuméraselas al cliente por su NOMBRE (no mandes fotos salvo que las pida). Para FOTOS de una, llama ver_habitaciones con "habitacion": <nombre>; para el panorama, con "fotos": true. Para precios y cupo real, usa ver_disponibilidad_hotel con fechas.` }
    }
    // Panorama de fotos (solo si el cliente las pidió): habitaciones + propiedad.
    const poolAll = [...(rooms.flatMap(r => r.photos || [])), ...propPhotos]
    const extra = `Habitaciones:\n${list}\nPide ver_habitaciones con el nombre para la ficha de una.`
    const res = sendPhotoBatch(poolAll, photoKey(convId, scoped.propertyId, 'all'), { maxPhotos, reset, label: propName, extra })
    if (!res.media?.length && !poolAll.length) return { text: `Habitaciones${propName ? ` de ${propName}` : ''}:\n${list}\n\nEste PMS no tiene fotos publicadas; consulta disponibilidad con fechas.` }
    return res
  }

  // ── Disponibilidad + cotización ───────────────────────────────────────────
  if (fn === 'ver_disponibilidad_hotel') {
    const { checkin, checkout } = args
    if (!isDate(checkin) || !isDate(checkout)) return { text: 'Necesito las fechas en formato YYYY-MM-DD (check-in y check-out).' }
    if (checkout <= checkin) return { text: 'El check-out debe ser posterior al check-in.' }
    const adults = Math.max(1, Number(args.adultos) || 1)
    const children = Number(args.ninos) || 0
    const query = { checkin, checkout, adults, children, infants: Number(args.infantes) || 0, rooms: Number(args.habitaciones) || undefined, promoCode: args.codigo_promocional || undefined }
    const availRooms = filterBlockedRooms(cfg, scoped.propertyId, (await prov.getAvailability(scoped, query)).rooms)
    let options = buildOptions(availRooms, { adults, children })

    if (!options.length) {
      // Alternativas: intenta ±1..3 días con la misma duración de estadía.
      const nights = nightsBetween(checkin, checkout)
      const alts = []
      for (const shift of [1, -1, 2, 3]) {
        const ci = addDays(checkin, shift); if (ci <= new Date().toISOString().slice(0, 10) && shift < 0) continue
        const co = addDays(ci, nights)
        try {
          const r = await prov.getAvailability(scoped, { ...query, checkin: ci, checkout: co })
          const opts = buildOptions(filterBlockedRooms(cfg, scoped.propertyId, r.rooms), { adults, children })
          if (opts.length) { alts.push({ checkin: ci, checkout: co, best: opts[0] }); if (alts.length >= 2) break }
        } catch {}
      }
      if (alts.length) {
        const altText = alts.map(a => `• ${a.checkin} → ${a.checkout}: ${a.best.roomName} desde ${fmtMoney(a.best.total, currency) || 'consultar'}`).join('\n')
        return { text: `No hay disponibilidad del ${checkin} al ${checkout} para ${adults + children} persona(s). PERO hay fechas cercanas disponibles:\n${altText}\nOfrécelas al cliente.` }
      }
      return { text: `No hay disponibilidad del ${checkin} al ${checkout} para ${adults + children} persona(s), ni en fechas cercanas. Sugiere al cliente otras fechas.` }
    }

    if (convId) _optionsCache.set(convId, { at: Date.now(), checkin, checkout, adults, children, promoCode: args.codigo_promocional || '', options })
    return {
      text: `Disponibilidad del ${checkin} al ${checkout} (${adults} adulto(s)${children ? ` + ${children} niño(s)` : ''}):\n` +
        optionsText(options, { checkin, checkout, currency }) +
        `\n\nPara reservar usa reservar_habitacion con el número de opción (necesitas nombre, email y teléfono del huésped).`,
    }
  }

  // ── Reservar ──────────────────────────────────────────────────────────────
  if (fn === 'reservar_habitacion') {
    const { checkin, checkout } = args
    if (!isDate(checkin) || !isDate(checkout)) return { text: 'Necesito las fechas exactas (YYYY-MM-DD) confirmadas por el cliente.' }
    const adults = Math.max(1, Number(args.adultos) || 1)
    const children = Number(args.ninos) || 0

    // Identidad del huésped: argumentos > conversación. HosRoom exige nombre+email+teléfono.
    const ident = await guestIdentity(accId, convId)
    const name = String(args.nombre || ident.name || '').trim()
    const email = String(args.email || ident.email || '').trim()
    const phone = String(args.telefono || ident.phone || '').trim()
    if (!name) return { text: 'Falta el NOMBRE del huésped. Pídeselo antes de reservar.' }
    if (!/.+@.+\..+/.test(email)) return { text: 'Falta el EMAIL del huésped (obligatorio para la reserva). Pídeselo antes de reservar.' }
    if (phone.replace(/\D/g, '').length < 7) return { text: 'Falta el TELÉFONO del huésped. Pídeselo antes de reservar.' }

    // Resuelve la tarifa: nº de opción de la última disponibilidad, o por nombre; re-verifica SIEMPRE en vivo.
    const cached = convId ? _optionsCache.get(convId) : null
    const cacheValid = cached && Date.now() - cached.at < OPTIONS_TTL && cached.checkin === checkin && cached.checkout === checkout
    let target = null
    if (args.opcion && cacheValid) target = cached.options.find(o => o.n === Number(args.opcion)) || null
    const liveRooms = filterBlockedRooms(cfg, scoped.propertyId, (await prov.getAvailability(scoped, { checkin, checkout, adults, children, promoCode: args.codigo_promocional || cached?.promoCode || undefined })).rooms)
    const liveOptions = buildOptions(liveRooms, { adults, children })
    if (!liveOptions.length) return { text: `Ya no hay disponibilidad del ${checkin} al ${checkout}. Consulta otras fechas con ver_disponibilidad_hotel.` }
    if (target) {
      const live = liveOptions.find(o => o.rateId === target.rateId)
      if (!live) return { text: `La opción ${args.opcion} (${target.roomName} — ${target.rateName}) ya no está disponible. Opciones vigentes:\n${optionsText(liveOptions, { checkin, checkout, currency })}` }
      target = live
    } else {
      const wanted = norm(args.plan || args.habitacion || '')
      if (wanted) {
        target = liveOptions.find(o => norm(`${o.roomName} ${o.rateName}`).includes(wanted)) ||
          liveOptions.find(o => norm(o.roomName).includes(wanted)) || null
      }
      if (!target && liveOptions.length === 1) target = liveOptions[0]
      if (!target) return { text: `Indica qué opción reservar. Disponibles del ${checkin} al ${checkout}:\n${optionsText(liveOptions, { checkin, checkout, currency })}\nVuelve a llamar reservar_habitacion con "opcion": <número>.` }
    }

    // Método de pago: HosRoom EXIGE el campo `payment` (true = pago en línea → genera link;
    // false = paga en efectivo/al llegar al hotel). Por defecto online si no se especifica.
    const metodo = String(args.metodo_pago || '').toLowerCase()
    const cashPay = /efectivo|hotel|llegada|contado|cash|presencial|recepci/.test(metodo)
    const onlinePay = !cashPay

    const surnameSplit = name.split(/\s+/)
    let booking
    try {
      booking = await prov.book(scoped, {
        checkin, checkout, adults, children,
        infants: Number(args.infantes) || 0,
        availability: { [target.rateId]: 1 },
        customer: { name: surnameSplit[0], surname: surnameSplit.slice(1).join(' ') || undefined, mail: email, phone },
        notes: args.nota || undefined,
        promoCode: args.codigo_promocional || cached?.promoCode || undefined,
        payment: onlinePay,
      })
    } catch (e) {
      // Registra el error CRUDO de HosRoom (+ el cuerpo que enviamos) en el modo debug del
      // chat y en el log del servidor, para diagnosticar exactamente qué campo pide el PMS.
      const detail = { hosroomError: e.message, status: e.status || null, requestBody: { rateId: target.rateId, availability: { [target.rateId]: 1 }, payment: onlinePay, checkin, checkout, adults, children, customer: { name, email, phone } } }
      try { require('../flow/store').appendDebugEntry(accId, agId, convId, { type: 'error', title: '🏨 HosRoom: fallo al crear la reserva', detail }) } catch {}
      console.warn('[PMS book] HosRoom error:', e.message, JSON.stringify(detail.requestBody))
      return { text: `No se pudo crear la reserva en el PMS del hotel. Error técnico REAL de HosRoom: "${e.message}".${cashPay ? ' Puede que el hotel EXIJA pago en línea.' : ''} (El detalle técnico quedó registrado en el modo debug 🐛 de este chat.) Relata al cliente que hubo un inconveniente y NO inventes que se reservó.` }
    }

    const totalTxt = booking.total ? fmtMoney(booking.total, currency) : (target.total != null ? fmtMoney(target.total, currency) : null)
    // CRM + nota interna (no críticos).
    upsertCrmContact(accId, { name, phone, email }, `Reserva ${booking.code} · ${checkin}→${checkout} · ${target.roomName}`).catch(() => {})
    if (cfg.notifyTeam !== false) internalNote(accId, agId, convId, `🏨 RESERVA PMS creada por el asistente: ${booking.code} — ${target.roomName} (${target.rateName}) del ${checkin} al ${checkout} para ${adults + children} persona(s). Huésped: ${name} · ${phone} · ${email}${totalTxt ? ` · Total: ${totalTxt}` : ''}`).catch(() => {})

    const payLine = onlinePay
      ? (booking.paymentUrl ? `\n• Pago EN LÍNEA — link: ${booking.paymentUrl}` : '\n• Pago en línea (el hotel enviará el detalle de pago).')
      : '\n• Pago EN EFECTIVO al llegar al hotel.'
    return {
      text: `✅ Reserva CREADA en el PMS.\n• Código: ${booking.code}\n• ${target.roomName} — ${target.rateName}\n• ${checkin} → ${checkout} (${nightsBetween(checkin, checkout)} noche(s))\n• Huésped: ${name}${totalTxt ? `\n• Total: ${totalTxt}` : ''}${payLine}\nConfírmale al cliente el código de reserva${onlinePay && booking.paymentUrl ? ' y envíale el link de pago' : (onlinePay ? '' : ' e indícale que pagará en efectivo al llegar')}.`,
      booked: true,
      bookingCode: booking.code,
    }
  }

  // ── Seguimiento ───────────────────────────────────────────────────────────
  if (fn === 'ver_reserva') {
    const code = String(args.codigo || '').trim()
    if (!code) return { text: 'Necesito el código de la reserva (ej. HR-123456789).' }
    try {
      const b = await prov.getBooking(cfg, code)
      const fmtD = s => String(s || '').slice(0, 10)
      // No se incluye el link de pago en la CONSULTA (solo se entrega al crear la
      // reserva): evita cosechar links de pago enumerando códigos por el proxy público.
      return { text: `Reserva ${b.code}:\n• Estado: ${b.status}\n• Huésped: ${b.guestName || '—'}\n• ${fmtD(b.checkin)} → ${fmtD(b.checkout)}${b.nights ? ` (${b.nights} noches)` : ''}${b.total ? `\n• Total: ${fmtMoney(b.total, currency)}` : ''}` }
    } catch (e) {
      if (e.status === 404) return { text: `No existe una reserva con el código ${code}. Verifica el código con el cliente.` }
      throw e
    }
  }

  // ── Cancelar ──────────────────────────────────────────────────────────────
  // Si el proveedor soporta cancelación NATIVA (Kunas), se ejecuta de verdad.
  // Si no (HosRoom, cuyo engine no expone el endpoint), se registra como solicitud
  // gestionada + aviso al equipo.
  if (fn === 'cancelar_reserva') {
    const code = String(args.codigo || '').trim()
    if (!code) return { text: 'Necesito el código de la reserva para cancelarla.' }
    let detail = ''
    try { const b = await prov.getBooking(cfg, code); detail = ` (${b.guestName || 'huésped'} · ${String(b.checkin || '').slice(0, 10)}→${String(b.checkout || '').slice(0, 10)})` }
    catch (e) { if (e.status === 404) return { text: `No existe una reserva con el código ${code}. Verifica el código.` } }
    const motivo = String(args.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (typeof prov.cancel === 'function') {
      try {
        await prov.cancel(cfg, code)
        if (cfg.notifyTeam !== false) internalNote(accId, agId, convId, `🏨 RESERVA PMS CANCELADA por el asistente: ${code}${detail}.${motivo ? ` Motivo: ${motivo}` : ''}`).catch(() => {})
        return { text: `✅ Reserva ${code} CANCELADA en el PMS. Confírmale al cliente que su reserva quedó cancelada.` }
      } catch (e) {
        return { text: `No se pudo cancelar la reserva ${code}: ${e.message}` }
      }
    }
    await internalNote(accId, agId, convId, `🏨 SOLICITUD PMS: el cliente pide CANCELAR la reserva ${code}${detail}.${motivo ? ` Motivo: ${motivo}` : ''} — Requiere gestión manual en ${pub.providerLabel || 'el PMS'}.`)
    return { text: `⚠ La cancelación NO se ejecutó automáticamente en el PMS (${pub.providerLabel || 'este PMS'} no permite cancelar por API). Se registró la SOLICITUD y se avisó al equipo del hotel, que la procesará y confirmará. IMPORTANTE para tu respuesta al cliente: dile que su SOLICITUD de cancelación quedó registrada y que el hotel se la confirmará en breve; NO afirmes que la reserva ya está cancelada.` }
  }

  // ── Reagendar: solicitud gestionada (aviso al equipo) ─────────────────────
  if (fn === 'reagendar_reserva') {
    const code = String(args.codigo || '').trim()
    if (!code) return { text: 'Necesito el código de la reserva para registrar el cambio de fechas.' }
    let detail = ''
    try { const b = await prov.getBooking(cfg, code); detail = ` (${b.guestName || 'huésped'} · ${String(b.checkin || '').slice(0, 10)}→${String(b.checkout || '').slice(0, 10)})` }
    catch (e) { if (e.status === 404) return { text: `No existe una reserva con el código ${code}. Verifica el código.` } }
    const cleanDate = s => (isDate(s) ? s : '?')
    const motivo = String(args.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    await internalNote(accId, agId, convId, `🏨 SOLICITUD PMS: el cliente pide REAGENDAR la reserva ${code}${detail} → nuevas fechas: ${cleanDate(args.nueva_checkin)} a ${cleanDate(args.nueva_checkout)}.${motivo ? ` Motivo: ${motivo}` : ''} — Requiere gestión manual en ${pub.providerLabel || 'el PMS'}.`)
    return { text: `⚠ El cambio de fechas NO se ejecutó automáticamente en el PMS (${pub.providerLabel || 'este PMS'} no permite reagendar por API). Se registró la SOLICITUD y se avisó al equipo del hotel. IMPORTANTE para tu respuesta al cliente: dile que su SOLICITUD de cambio de fechas quedó registrada y que el hotel se la confirmará; NO afirmes que la reserva ya quedó reagendada.` }
  }

  return { text: `Función PMS desconocida: ${fn}` }
}

// ── Lectura para la UI (subpestañas Propiedades / Disponibilidad) ───────────────
const mapRoomPublic = r => ({
  id: r.id, name: r.name, capacity: r.capacity, description: r.description || '',
  photos: Array.isArray(r.photos) ? r.photos.filter(Boolean) : [],
  rates: (r.rates || []).map(rt => ({ name: rt.name, mealType: rt.mealType || '', total: rt.total ?? null, perNight: rt.perNight ?? null, capacity: rt.capacity ?? null, available: rt.available ?? null })),
})

// Propiedades accesibles (Kunas puede tener varias). HosRoom: 0/1 (el propio hotel).
// Para el PANEL admin: devuelve TODAS con su flag `blocked` (para poder togglear).
async function listProperties(accId) {
  const cfg = await loadConfig(accId)
  const blocked = (Array.isArray(cfg?.blockedProperties) ? cfg.blockedProperties : []).map(String)
  let list = []
  if (Array.isArray(cfg?.properties) && cfg.properties.length) list = cfg.properties
  else {
    const prov = providers.getProvider(cfg?.provider)
    if (prov && typeof prov.listProperties === 'function') {
      list = (await prov.listProperties(cfg).catch(() => [])).map(p => ({ id: String(p.id), name: p.name || `Propiedad ${p.id}` }))
      if (list.length) await saveConfig(accId, { ...cfg, properties: list }).catch(() => {})
    } else if (cfg?.hotelName) list = [{ id: cfg.propertyId || 'default', name: cfg.hotelName }]
  }
  return list.map(p => ({ id: String(p.id), name: p.name || `Propiedad ${p.id}`, blocked: blocked.includes(String(p.id)) }))
}

// Habitaciones con ficha, fotos y planes (opcionalmente de una propiedad concreta).
// Devuelve también la propiedad (con sus fotos y descripción) cuando el proveedor
// la expone (Kunas: /api/property/data/property).
async function listRooms(accId, { propertyId } = {}) {
  const cfg = await loadConfig(accId)
  if (!publicConfig(cfg).connected) throw new Error('El PMS no está conectado.')
  const prov = providers.getProvider(cfg.provider)
  const c = propertyId ? { ...cfg, propertyId: String(propertyId) } : cfg
  const propId = c.propertyId || (Array.isArray(cfg.properties) && cfg.properties[0]?.id) || 'default'
  const blockedProps = (Array.isArray(cfg.blockedProperties) ? cfg.blockedProperties : []).map(String)
  let property = null
  const p = await getPropertyCached(accId, c).catch(() => null)
  if (p) property = { id: String(propId), name: p.name || '', description: p.description || '', photos: Array.isArray(p.photos) ? p.photos.filter(Boolean) : [], blocked: blockedProps.includes(String(propId)) }
  const rooms = await getRoomsCached(accId, c)
  // Kunas expone las fotos SOLO a nivel de propiedad: si el alojamiento no trae
  // fotos propias, usa la galería de su propiedad (para que no salga vacío).
  const propPhotos = property?.photos || []
  // Panel admin: TODAS las habitaciones con su flag `blocked` (para togglear).
  return {
    rooms: rooms.map(r => { const m = mapRoomPublic(r); if (!m.photos.length) m.photos = propPhotos; return { ...m, blocked: isRoomBlocked(cfg, propId, r.id) } }),
    property, propertyId: String(propId),
  }
}

// Disponibilidad para un rango (una sola consulta): habitaciones con precio.
async function rangeAvailability(accId, { checkin, checkout, adults, children, propertyId } = {}) {
  if (!isDate(checkin) || !isDate(checkout) || checkout <= checkin) throw new Error('Fechas inválidas (YYYY-MM-DD, checkout > checkin).')
  const cfg = await loadConfig(accId)
  if (!publicConfig(cfg).connected) throw new Error('El PMS no está conectado.')
  const prov = providers.getProvider(cfg.provider)
  const c = propertyId ? { ...cfg, propertyId: String(propertyId) } : cfg
  const { rooms } = await prov.getAvailability(c, { checkin, checkout, adults: Math.max(1, Number(adults) || 2), children: Number(children) || 0 })
  const nights = nightsBetween(checkin, checkout)
  return {
    checkin, checkout, nights, currency: publicConfig(cfg).currency,
    rooms: rooms.map(r => ({
      ...mapRoomPublic(r),
      bestTotal: (r.rates || []).reduce((m, rt) => (rt.total != null && (m == null || rt.total < m) ? rt.total : m), null),
      available: (r.rates || []).reduce((s, rt) => s + (Number(rt.available) || 0), 0),
    })).filter(r => r.available > 0 || r.rates.length),
  }
}

// Disponibilidad por MES (heatmap del calendario) para una habitación concreta.
// Escanea los días futuros del mes como estadías de 1 noche, con concurrencia y caché.
const _monthCache = new Map()   // key → { at, data }
const MONTH_TTL = 3 * 60 * 1000
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}
async function runLimited(items, limit, fn) {
  const q = items.slice(); const active = new Set()
  async function pump() {
    while (q.length && active.size < limit) {
      const it = q.shift()
      const p = Promise.resolve(fn(it)).finally(() => active.delete(p))
      active.add(p)
    }
    if (active.size) { await Promise.race(active); return pump() }
  }
  await pump()
}
async function monthAvailability(accId, { year, month, roomTypeId, propertyId, adults }) {
  const y = Number(year), m = Number(month)
  if (!y || !m || m < 1 || m > 12) throw new Error('Mes inválido.')
  const key = `${accId}:${y}-${m}:${roomTypeId || '*'}:${propertyId || '*'}:${adults || 2}`
  const hit = _monthCache.get(key)
  if (hit && Date.now() - hit.at < MONTH_TTL) return hit.data
  const cfg = await loadConfig(accId)
  if (!publicConfig(cfg).connected) throw new Error('El PMS no está conectado.')
  const prov = providers.getProvider(cfg.provider)
  const c = propertyId ? { ...cfg, propertyId: String(propertyId) } : cfg
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const today = new Date().toISOString().slice(0, 10)
  const pad = n => String(n).padStart(2, '0')

  // Vía rápida: el proveedor puede dar todo el rango en UNA llamada (Kunas /avail).
  if (typeof prov.getMonthAvailability === 'function') {
    const dfrom = `${y}-${pad(m)}-01`
    const dto = addDays(`${y}-${pad(m)}-${pad(daysInMonth)}`, 1)
    const map = await prov.getMonthAvailability(c, { dfrom, dto })   // { rtId: { fecha: cupo } }
    const out = {}
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${y}-${pad(m)}-${pad(d)}`
      if (date < today) continue
      let available = 0
      if (roomTypeId) available = Number((map[String(roomTypeId)] || {})[date]) || 0
      else for (const byDate of Object.values(map)) available += Number(byDate[date]) || 0
      out[date] = { available, price: null }
    }
    const data = { year: y, month: m, currency: publicConfig(cfg).currency, days: out }
    _monthCache.set(key, { at: Date.now(), data })
    return data
  }

  const dates = []
  for (let d = 1; d <= daysInMonth; d++) { const date = `${y}-${pad(m)}-${pad(d)}`; if (date >= today) dates.push(date) }
  const out = {}
  await runLimited(dates, 6, async date => {
    const next = addDays(date, 1)
    try {
      const { rooms } = await withTimeout(prov.getAvailability(c, { checkin: date, checkout: next, adults: Math.max(1, Number(adults) || 2), children: 0 }), 8000)
      let available = 0, price = null
      for (const rm of rooms) {
        if (roomTypeId && String(rm.id) !== String(roomTypeId)) continue
        for (const rt of (rm.rates || [])) { available += Number(rt.available) || 0; if (rt.total != null && (price == null || rt.total < price)) price = rt.total }
      }
      out[date] = { available, price }
    } catch { out[date] = { error: true } }
  })
  const data = { year: y, month: m, currency: publicConfig(cfg).currency, days: out }
  _monthCache.set(key, { at: Date.now(), data })
  if (_monthCache.size > 200) { for (const [k, v] of _monthCache) if (Date.now() - v.at > MONTH_TTL) _monthCache.delete(k) }
  return data
}

// Diagnóstico: respuestas crudas del PMS para afinar el mapeo (solo super/lectura interna).
async function debug(accId) {
  const cfg = await loadConfig(accId)
  const prov = providers.getProvider(cfg?.provider)
  if (!prov) return { error: 'Sin proveedor configurado.' }
  if (typeof prov.debug !== 'function') return { note: 'Este proveedor no expone diagnóstico.' }
  const raw = await prov.debug(cfg).catch(e => ({ error: e.message }))
  // Recorta para no devolver megas.
  const s = JSON.stringify(raw)
  return s.length > 60000 ? { truncated: true, sample: s.slice(0, 60000) } : raw
}

module.exports = { loadConfig, saveConfig, publicConfig, testConnection, toolCall, listProperties, listRooms, rangeAvailability, monthAvailability, debug }
