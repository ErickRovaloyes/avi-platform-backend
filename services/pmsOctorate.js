'use strict'
/**
 * Octorate como proveedor de PMS.
 *
 * Traduce la API de Octorate al contrato común de `pmsProviders.js` —el mismo que cumplen
 * HosRoom y Kunas—, de modo que el asistente, las herramientas IA y el indexado vectorial de
 * habitaciones no se enteran de qué PMS hay debajo.
 *
 * La pieza central es `/reservation/{acc}/search`: el buscador de su motor de reservas. En una
 * llamada devuelve habitaciones, cupo, tarifas y todos los cargos, así que sirve a la vez para
 * listar habitaciones, para cotizar y para revalidar antes de reservar.
 */
const oct = require('./octorate')

const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v])
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null }
const txt = (...xs) => xs.find(x => x !== undefined && x !== null && String(x).trim() !== '') ?? ''

/**
 * El id de cuenta, que Octorate necesita para renovar el token.
 *
 * Los proveedores reciben solo `cfg`, así que `loadConfig` lo deja dentro. Es la via menos
 * invasiva: no cambia ninguna llamada ni afecta a HosRoom ni a Kunas.
 */
function cuentaDe(cfg) {
  const id = cfg?._accId
  if (!id) throw new Error('Octorate: falta el id de cuenta en la configuracion.')
  return id
}

/** La propiedad con la que operar: la indicada, la configurada, o la primera de la red. */
function propiedadDe(cfg, propArg) {
  return String(propArg || cfg?.propertyId || (Array.isArray(cfg?.properties) && cfg.properties[0]?.id) || '').trim()
}

function fechaMas(dias, desde) {
  const d = desde ? new Date(`${desde}T12:00:00Z`) : new Date()
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/**
 * Una fila de `SearchRoomResult` → la forma de tarifa del contrato.
 *
 * El precio de Octorate es el de la habitación; los cargos (limpieza, resort, desayuno…) vienen
 * aparte. Se suman en `total` porque es lo que el cliente va a pagar: dar el precio sin los
 * cargos es la clase de dato que genera una queja al llegar al hotel.
 */
function tarifaDe(r) {
  const base = num(r.price) || 0
  const cargos = ['bookingFee', 'peopleFee', 'otherFee', 'dayFee', 'hotelFee', 'resortFee', 'serviceCharge']
    .reduce((s, k) => s + (num(r[k]) || 0), 0)
  return {
    id: `${txt(r.room, r.roomId)}:${txt(r.rate, r.rateId)}`,
    name: txt(r.ratePlanName, r.name, 'Tarifa'),
    description: '',
    mealType: num(r.breakfastPrice) > 0 ? 'Desayuno aparte' : '',
    total: base + cargos,
    perNight: null,
    available: num(r.availability),
    _roomId: String(txt(r.room, r.roomId)),
    _rateId: String(txt(r.rate, r.rateId)),
    _bookUrl: r.bookUrl || null,
    raw: r,
  }
}

/** Agrupa las filas del buscador por habitación, que es como las espera el contrato. */
function agrupar(filas) {
  const porHab = new Map()
  for (const r of arr(filas)) {
    const id = String(txt(r.room, r.roomId))
    if (!id) continue
    if (!porHab.has(id)) {
      porHab.set(id, {
        id,
        name: txt(r.name, 'Habitación'),
        capacity: num(r.guests) || 2,
        description: '',
        photos: [],
        basePrice: 0,
        rates: [],
        raw: r,
      })
    }
    porHab.get(id).rates.push(tarifaDe(r))
  }
  for (const h of porHab.values()) {
    const totales = h.rates.map(t => t.total).filter(n => n > 0)
    h.basePrice = totales.length ? Math.min(...totales) : 0
  }
  return [...porHab.values()]
}

module.exports = {
  id: 'octorate',
  label: 'Octorate',

  // El cliente no pega un token: autoriza en el panel de Octorate. Los campos son los de la
  // aplicación de partner, y sólo los toca quien monta la integración.
  credentialFields: () => ['clientId', 'clientSecret'],
  requires: ['oauth'],

  async testConnection(cfg) {
    const accId = cuentaDe(cfg)
    if (!cfg?.oauth?.accessToken && !cfg?.oauth?.refreshToken) {
      return { ok: false, message: 'Aún no has autorizado la conexión con Octorate.' }
    }
    try {
      const props = arr(await oct.listarPropiedades(accId, cfg))
      if (!props.length) return { ok: false, message: 'Octorate respondió, pero esta cuenta no tiene propiedades visibles.' }
      const nombres = props.slice(0, 3).map(p => txt(p.name, p.id)).join(', ')
      return { ok: true, message: `Conectado · ${props.length} propiedad(es): ${nombres}${props.length > 3 ? '…' : ''}` }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  },

  async listProperties(cfg) {
    const accId = cuentaDe(cfg)
    return arr(await oct.listarPropiedades(accId, cfg)).map(p => ({
      id: String(txt(p.id, p.accommodationId)),
      name: txt(p.name, 'Propiedad'),
      city: txt(p.city),
      address: txt(p.address),
      currency: txt(p.currency, 'EUR'),
      raw: p,
    }))
  },

  async getProperty(cfg, propArg) {
    const accId = cuentaDe(cfg)
    const acc = propiedadDe(cfg, propArg)
    if (!acc) throw new Error('Octorate: falta indicar la propiedad.')
    const p = await oct.verPropiedad(accId, cfg, acc)
    let fotos = []
    // Las fotos son un extra: si fallan, la ficha sigue sirviendo.
    try { fotos = arr(await oct.fotosPropiedad(accId, cfg, acc)).map(f => txt(f.url, f.link, f)).filter(Boolean) } catch { /* sin fotos */ }
    return {
      id: String(txt(p?.id, acc)),
      name: txt(p?.name, 'Propiedad'),
      description: '',
      address: txt(p?.address),
      city: txt(p?.city),
      phone: txt(p?.phoneNumber),
      currency: txt(p?.currency, 'EUR'),
      checkin: txt(p?.checkinStart),
      checkout: txt(p?.checkout),
      photos: fotos,
      raw: p,
    }
  },

  /**
   * Las habitaciones del alojamiento.
   *
   * Octorate NO tiene un «listar habitaciones»: `roomrates` solo responde por habitación
   * concreta. Se deducen del buscador pidiendo un rango amplio y SIN comprobar disponibilidad,
   * para que no desaparezca un tipo de habitación solo porque esos días esté lleno.
   */
  async getRooms(cfg, propArg) {
    const accId = cuentaDe(cfg)
    const acc = propiedadDe(cfg, propArg)
    if (!acc) return []
    const filas = await oct.buscar(accId, cfg, acc, {
      checkin: fechaMas(1), checkout: fechaMas(3), availcheck: false, currency: cfg.currency || undefined,
    })
    const habs = agrupar(filas)
    // La descripción y las fotos sí son por habitación: se piden en paralelo y con tope, que
    // una consulta del cliente no puede esperar a treinta llamadas.
    await Promise.all(habs.slice(0, 20).map(async h => {
      try {
        const d = await oct.verHabitacion(accId, cfg, acc, h.id)
        h.description = txt(d?.description, d?.summary, '')
        h.capacity = num(d?.maxGuests) || num(d?.capacity) || h.capacity
        h.photos = arr(d?.images || d?.photos).map(i => txt(i.url, i.link, i)).filter(Boolean)
      } catch { /* la habitación se queda con lo que dio el buscador */ }
    }))
    return habs
  },

  async getRoomPhotos(cfg, roomId, propArg) {
    const accId = cuentaDe(cfg)
    const acc = propiedadDe(cfg, propArg)
    try {
      const d = await oct.verHabitacion(accId, cfg, acc, roomId)
      return arr(d?.images || d?.photos).map(i => txt(i.url, i.link, i)).filter(Boolean)
    } catch { return [] }
  },

  async getAvailability(cfg, { checkin, checkout, adults, children, property } = {}) {
    const accId = cuentaDe(cfg)
    const acc = propiedadDe(cfg, property)
    if (!acc) throw new Error('Octorate: falta indicar la propiedad.')
    const filas = await oct.buscar(accId, cfg, acc, {
      checkin, checkout, adults, children, availcheck: true, currency: cfg.currency || undefined,
    })
    // Solo lo que de verdad se puede vender: `availability` a 0 es una habitación llena, y
    // ofrecerla es peor que no tener nada que ofrecer.
    const habs = agrupar(filas).map(h => ({ ...h, rates: h.rates.filter(t => (t.available == null || t.available > 0)) }))
    return { rooms: habs.filter(h => h.rates.length) }
  },

  // Cotizar es el mismo buscador: Octorate ya devuelve el precio con la disponibilidad.
  async quote(cfg, params) { return this.getAvailability(cfg, params) },

  async book(cfg, { checkin, checkout, adults, children, availability, customer = {}, notes, property } = {}) {
    const accId = cuentaDe(cfg)
    const acc = propiedadDe(cfg, property)
    const rateId = Object.keys(availability || {})[0] || ''
    if (!acc || !rateId) throw new Error('Octorate: falta la propiedad o la habitación a reservar.')

    // Se revalida contra el buscador: entre que se ofreció la opción y el cliente dijo que sí,
    // pueden haber vendido la última habitación.
    const { rooms } = await this.getAvailability(cfg, { checkin, checkout, adults, children, property: acc })
    const opcion = rooms.flatMap(h => h.rates).find(t => t.id === rateId)
    if (!opcion) throw new Error('La habitación elegida ya no está disponible para esas fechas.')

    const ahora = new Date().toISOString()
    const refer = `AVI-${Date.now().toString(36).toUpperCase()}`
    const d = await oct.crearReserva(accId, cfg, acc, {
      status: 'CONFIRMED',
      refer,
      channelId: cfg.channelId || 'DIRECT',
      product: opcion._roomId,
      rate: opcion._rateId,
      checkin, checkout,
      createTime: ahora, updateTime: ahora,
      totalGuest: Math.max(1, Number(adults) || 1) + (Number(children) || 0),
      totalChildren: Number(children) || 0,
      totalInfants: 0,
      roomGross: opcion.total,
      privateNotes: notes || '',
      guests: [{
        name: txt(customer.name, 'Huésped'),
        email: txt(customer.email),
        phone: txt(customer.phone),
      }],
    })
    const code = String(txt(d?.refer, d?.id, refer))
    return {
      code,
      status: txt(d?.status, 'CONFIRMED'),
      total: opcion.total,
      currency: cfg.currency || 'EUR',
      _octorateId: txt(d?.id),
      raw: d,
    }
  },

  async getBooking(cfg, code, propArg) {
    const accId = cuentaDe(cfg)
    const acc = propiedadDe(cfg, propArg)
    const d = await oct.verReserva(accId, cfg, acc, code)
    if (!d) throw Object.assign(new Error('Reserva no encontrada'), { status: 404 })
    return {
      code: String(txt(d.refer, d.id, code)),
      status: txt(d.status, ''),
      checkin: txt(d.checkin), checkout: txt(d.checkout),
      total: num(d.roomGross),
      guest: txt(arr(d.guests)[0]?.name),
      raw: d,
    }
  },

  async cancel(cfg, code, propArg) {
    const accId = cuentaDe(cfg)
    const acc = propiedadDe(cfg, propArg)
    await oct.borrarReserva(accId, cfg, acc, code)
    return { ok: true, status: 'CANCELLED', code: String(code) }
  },

  async reschedule(cfg, code, { checkin, checkout, property } = {}) {
    const accId = cuentaDe(cfg)
    const acc = propiedadDe(cfg, property)
    const d = await oct.modificarReserva(accId, cfg, acc, code, {
      checkin, checkout, updateTime: new Date().toISOString(),
    })
    return { ok: true, code: String(code), checkin, checkout, raw: d }
  },

  async debug(cfg) {
    const accId = cuentaDe(cfg)
    const out = { provider: 'octorate', autorizado: !!cfg?.oauth?.refreshToken }
    try { out.propiedades = (await this.listProperties(cfg)).map(p => `${p.id} · ${p.name}`) }
    catch (e) { out.errorPropiedades = e.message }
    return out
  },
}
