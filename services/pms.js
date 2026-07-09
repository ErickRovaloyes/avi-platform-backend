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

// Config pública (sin token) — va dentro de account.pms para el runtime/UI.
function publicConfig(cfg) {
  const c = cfg || {}
  const connected = !!(c.provider && c.token && !providers.getProvider(c.provider)?.comingSoon)
  return {
    connected,
    provider: c.provider || '',
    providerLabel: providers.getProvider(c.provider)?.label || '',
    hotelName: c.hotelName || '',
    currency: c.currency || 'COP',
    maxPhotos: Number(c.maxPhotos) || 4,
  }
}

async function testConnection(accId) {
  const cfg = await loadConfig(accId)
  if (!cfg?.provider) return { ok: false, message: 'Elige un proveedor y guarda el token.' }
  const prov = providers.getProvider(cfg.provider)
  if (!prov) return { ok: false, message: `Proveedor desconocido: ${cfg.provider}` }
  const r = await prov.testConnection(cfg)
  // Guarda el nombre del hotel para mostrarlo en la UI y en las respuestas.
  if (r.ok && r.hotelName) { await saveConfig(accId, { ...cfg, hotelName: r.hotelName }).catch(() => {}) }
  return r
}

// ── Cachés en memoria ──────────────────────────────────────────────────────────
// Habitaciones: 5 min por cuenta (la disponibilidad NUNCA se cachea).
const _roomsCache = new Map()   // accId → { at, rooms }
const ROOMS_TTL = 5 * 60 * 1000
// Últimas opciones de disponibilidad por conversación (para reservar por número).
const _optionsCache = new Map() // convId → { at, checkin, checkout, adults, children, options: [{n, rateId, roomName, rateName, total}] }
const OPTIONS_TTL = 20 * 60 * 1000

async function getRoomsCached(accId, cfg) {
  const hit = _roomsCache.get(accId)
  if (hit && Date.now() - hit.at < ROOMS_TTL) return hit.rooms
  const prov = providers.getProvider(cfg.provider)
  const rooms = await prov.getRooms(cfg)
  _roomsCache.set(accId, { at: Date.now(), rooms })
  return rooms
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

  // ── Ver habitaciones (con fotos) ──────────────────────────────────────────
  if (fn === 'ver_habitaciones') {
    const rooms = await getRoomsCached(accId, cfg)
    if (!rooms.length) return { text: 'El hotel no tiene habitaciones publicadas en el PMS.' }
    const wanted = norm(args.habitacion || '')
    if (wanted) {
      const room = rooms.find(r => norm(r.name).includes(wanted) || wanted.includes(norm(r.name))) ||
        rooms.find(r => norm(r.name).split(/\s+/).some(w => wanted.includes(w) && w.length > 3))
      if (!room) return { text: `No encontré una habitación llamada "${args.habitacion}". Las disponibles son: ${rooms.map(r => r.name).join(', ')}.` }
      const media = room.photos.slice(0, pub.maxPhotos).map((url, i) => ({ url, caption: i === 0 ? `${room.name} (capacidad ${room.capacity})` : '' }))
      const plans = (room.rates || []).map(rt => `• ${rt.name}${rt.mealType === 'breakfast' ? ' (con desayuno)' : ''}`).join('\n')
      return {
        text: `Envié ${media.length} foto(s) de "${room.name}" al cliente. Ficha: capacidad ${room.capacity} persona(s). ${room.description || ''}${plans ? `\nPlanes: \n${plans}` : ''}\nPara precios exactos usa ver_disponibilidad_hotel con las fechas.`,
        media,
      }
    }
    // Panorama general: 1 foto de portada por habitación (máx 6).
    const media = rooms.slice(0, 6).filter(r => r.photos[0]).map(r => ({ url: r.photos[0], caption: `${r.name} · ${r.capacity} persona(s)` }))
    const list = rooms.map(r => `• ${r.name} — capacidad ${r.capacity}${r.description ? ` — ${String(r.description).slice(0, 110)}` : ''}`).join('\n')
    return { text: `Habitaciones del hotel (envié una foto de cada una):\n${list}\n\nPide "ver_habitaciones" con el nombre para más fotos, o consulta disponibilidad con fechas.`, media }
  }

  // ── Disponibilidad + cotización ───────────────────────────────────────────
  if (fn === 'ver_disponibilidad_hotel') {
    const { checkin, checkout } = args
    if (!isDate(checkin) || !isDate(checkout)) return { text: 'Necesito las fechas en formato YYYY-MM-DD (check-in y check-out).' }
    if (checkout <= checkin) return { text: 'El check-out debe ser posterior al check-in.' }
    const adults = Math.max(1, Number(args.adultos) || 1)
    const children = Number(args.ninos) || 0
    const query = { checkin, checkout, adults, children, infants: Number(args.infantes) || 0, rooms: Number(args.habitaciones) || undefined, promoCode: args.codigo_promocional || undefined }
    const { rooms: availRooms } = await prov.getAvailability(cfg, query)
    let options = buildOptions(availRooms, { adults, children })

    if (!options.length) {
      // Alternativas: intenta ±1..3 días con la misma duración de estadía.
      const nights = nightsBetween(checkin, checkout)
      const alts = []
      for (const shift of [1, -1, 2, 3]) {
        const ci = addDays(checkin, shift); if (ci <= new Date().toISOString().slice(0, 10) && shift < 0) continue
        const co = addDays(ci, nights)
        try {
          const r = await prov.getAvailability(cfg, { ...query, checkin: ci, checkout: co })
          const opts = buildOptions(r.rooms, { adults, children })
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
    const { rooms: liveRooms } = await prov.getAvailability(cfg, { checkin, checkout, adults, children, promoCode: args.codigo_promocional || cached?.promoCode || undefined })
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

    const surnameSplit = name.split(/\s+/)
    const booking = await prov.book(cfg, {
      checkin, checkout, adults, children,
      infants: Number(args.infantes) || 0,
      availability: { [target.rateId]: 1 },
      customer: { name: surnameSplit[0], surname: surnameSplit.slice(1).join(' ') || undefined, mail: email, phone },
      notes: args.nota || undefined,
      promoCode: args.codigo_promocional || cached?.promoCode || undefined,
    })

    const totalTxt = booking.total ? fmtMoney(booking.total, currency) : (target.total != null ? fmtMoney(target.total, currency) : null)
    // CRM + nota interna (no críticos).
    upsertCrmContact(accId, { name, phone, email }, `Reserva ${booking.code} · ${checkin}→${checkout} · ${target.roomName}`).catch(() => {})
    if (cfg.notifyTeam !== false) internalNote(accId, agId, convId, `🏨 RESERVA PMS creada por el asistente: ${booking.code} — ${target.roomName} (${target.rateName}) del ${checkin} al ${checkout} para ${adults + children} persona(s). Huésped: ${name} · ${phone} · ${email}${totalTxt ? ` · Total: ${totalTxt}` : ''}`).catch(() => {})

    return {
      text: `✅ Reserva CREADA en el PMS.\n• Código: ${booking.code}\n• ${target.roomName} — ${target.rateName}\n• ${checkin} → ${checkout} (${nightsBetween(checkin, checkout)} noche(s))\n• Huésped: ${name}${totalTxt ? `\n• Total: ${totalTxt}` : ''}${booking.paymentUrl ? `\n• Link de pago: ${booking.paymentUrl}` : ''}\nConfírmale al cliente el código de reserva${booking.paymentUrl ? ' y envíale el link de pago' : ''}.`,
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

  // ── Reagendar / cancelar: solicitud gestionada ────────────────────────────
  if (fn === 'reagendar_reserva' || fn === 'cancelar_reserva') {
    const code = String(args.codigo || '').trim()
    if (!code) return { text: 'Necesito el código de la reserva (ej. HR-123456789) para registrar la solicitud.' }
    // Verifica que exista y trae el detalle para la nota del equipo.
    let detail = ''
    try { const b = await prov.getBooking(cfg, code); detail = ` (${b.guestName || 'huésped'} · ${String(b.checkin || '').slice(0, 10)}→${String(b.checkout || '').slice(0, 10)})` }
    catch (e) { if (e.status === 404) return { text: `No existe una reserva con el código ${code}. Verifica el código.` } }

    const isCancel = fn === 'cancelar_reserva'
    const cleanDate = s => (isDate(s) ? s : '?')
    const motivo = String(args.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    const what = isCancel
      ? `CANCELAR la reserva ${code}${detail}`
      : `REAGENDAR la reserva ${code}${detail} → nuevas fechas: ${cleanDate(args.nueva_checkin)} a ${cleanDate(args.nueva_checkout)}`
    await internalNote(accId, agId, convId, `🏨 SOLICITUD PMS: el cliente pide ${what}.${motivo ? ` Motivo: ${motivo}` : ''} — Requiere gestión manual en ${pub.providerLabel || 'el PMS'}.`)
    return {
      text: `Solicitud registrada: ${isCancel ? 'cancelación' : 'reagendamiento'} de la reserva ${code}. El equipo del hotel la procesará en breve y el cliente recibirá confirmación. Dile al cliente que su solicitud quedó registrada y será confirmada pronto por el equipo.`,
    }
  }

  return { text: `Función PMS desconocida: ${fn}` }
}

module.exports = { loadConfig, saveConfig, publicConfig, testConnection, toolCall }
