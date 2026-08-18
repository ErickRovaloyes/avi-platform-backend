'use strict'
/**
 * Octorate como HERRAMIENTAS IA instalables desde el catálogo.
 *
 * En vez de configurarse en Zona IA → PMS, el cliente instala del catálogo las capacidades que
 * quiera: solo consultar habitaciones, o también cotizar, o también reservar. Cada ficha del
 * catálogo apunta a uno de estos handlers.
 *
 * Todos comparten la misma conexión: la que el hotelero autorizó por OAuth. Si no la ha
 * autorizado, la herramienta lo dice con claridad en vez de fallar con un error de API — el
 * asistente puede entonces decirle al cliente que hable con el hotel, y el dueño ve el aviso.
 *
 * La lógica de negocio NO se duplica: se apoya en `pmsOctorate`, el mismo adaptador que usa la
 * plataforma para el resto de PMS. Aquí solo se traduce a texto para el asistente.
 */
const pms = require('../pms')
const proveedor = require('../pmsOctorate')

const SIN_CONEXION = 'El hotel todavía no ha conectado su sistema de reservas (Octorate). Dile al cliente que en este momento no puedes consultar disponibilidad y que un asesor le ayudará.'

/** La configuración de Octorate de la cuenta, o null si aún no está autorizada. */
async function conexion(ctx) {
  const cfg = await pms.loadConfig(ctx.accId)
  if (!cfg || cfg.provider !== 'octorate') return null
  if (!cfg.oauth?.accessToken && !cfg.oauth?.refreshToken) return null
  return cfg
}

const dinero = (n, moneda) => `${Number(n || 0).toLocaleString('es-CO')} ${moneda || ''}`.trim()

/** Una habitación con sus tarifas, en texto que el asistente pueda contar con sus palabras. */
function habitacionATexto(h, moneda) {
  const tarifas = h.rates.map(t => {
    const cupo = t.available != null && t.available <= 3 ? ` · quedan ${t.available}` : ''
    return `   - ${t.name}: ${dinero(t.total, moneda)}${t.mealType ? ` (${t.mealType})` : ''}${cupo}`
  }).join('\n')
  return `${h.name} (hasta ${h.capacity} personas)${h.description ? `\n   ${h.description.slice(0, 200)}` : ''}${tarifas ? `\n${tarifas}` : ''}`
}

// ── Consultar habitaciones ────────────────────────────────────────────────────

const habitaciones = {
  clave: 'octorateHabitaciones',
  nombre: 'Octorate · Consultar habitaciones',
  descripcion: 'Lista las habitaciones del hotel con su descripción, capacidad y precio desde.',
  necesitaConexion: 'octorate',
  parametros: [],
  async ejecutar(ctx) {
    const cfg = await conexion(ctx)
    if (!cfg) return SIN_CONEXION
    const habs = await proveedor.getRooms(cfg)
    if (!habs.length) return 'El hotel no tiene habitaciones publicadas en este momento.'
    const moneda = cfg.currency || 'COP'
    return `Habitaciones del hotel (${habs.length}):\n` +
      habs.map(h => `${h.name} — desde ${dinero(h.basePrice, moneda)} · hasta ${h.capacity} personas` +
        (h.description ? `\n   ${h.description.slice(0, 200)}` : '')).join('\n')
  },
}

// ── Disponibilidad y precios ──────────────────────────────────────────────────

const disponibilidad = {
  clave: 'octorateDisponibilidad',
  nombre: 'Octorate · Disponibilidad y precios',
  descripcion: 'Consulta qué habitaciones hay libres para unas fechas y cuánto cuestan, con todos los cargos incluidos.',
  necesitaConexion: 'octorate',
  parametros: [
    { name: 'checkin', type: 'string', required: true, description: 'Fecha de entrada en formato AAAA-MM-DD.' },
    { name: 'checkout', type: 'string', required: true, description: 'Fecha de salida en formato AAAA-MM-DD.' },
    { name: 'adultos', type: 'number', required: true, description: 'Número de adultos.' },
    { name: 'ninos', type: 'number', required: false, description: 'Número de niños. 0 si no hay.' },
  ],
  async ejecutar(ctx, args) {
    const cfg = await conexion(ctx)
    if (!cfg) return SIN_CONEXION

    // Se valida antes de llamar: el modelo manda fechas mal escritas con frecuencia, y un error
    // de la API no le dice qué corregir.
    const fecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
    if (!fecha(args?.checkin) || !fecha(args?.checkout)) {
      return 'Necesito las fechas en formato AAAA-MM-DD (por ejemplo 2026-09-01). Pregúntale al cliente qué días quiere.'
    }
    if (args.checkout <= args.checkin) return 'La fecha de salida tiene que ser posterior a la de entrada.'

    const { rooms } = await proveedor.getAvailability(cfg, {
      checkin: args.checkin, checkout: args.checkout,
      adults: Number(args.adultos) || 1, children: Number(args.ninos) || 0,
    })
    const moneda = cfg.currency || 'COP'
    if (!rooms.length) {
      return `No hay disponibilidad del ${args.checkin} al ${args.checkout}. Ofrécele al cliente cambiar las fechas y vuelve a consultar.`
    }
    return `Disponible del ${args.checkin} al ${args.checkout} (${rooms.length} opción(es)). Los precios YA incluyen los cargos:\n` +
      rooms.map(h => habitacionATexto(h, moneda)).join('\n') +
      '\n\nPara reservar hace falta el nombre completo, el correo y el teléfono del cliente.'
  },
}

// ── Reservar ──────────────────────────────────────────────────────────────────

const reservar = {
  clave: 'octorateReservar',
  nombre: 'Octorate · Crear reserva',
  descripcion: 'Crea la reserva en el hotel. Úsala solo después de consultar disponibilidad y de que el cliente confirme la habitación y dé sus datos.',
  necesitaConexion: 'octorate',
  parametros: [
    { name: 'checkin', type: 'string', required: true, description: 'Fecha de entrada AAAA-MM-DD.' },
    { name: 'checkout', type: 'string', required: true, description: 'Fecha de salida AAAA-MM-DD.' },
    { name: 'habitacion', type: 'string', required: true, description: 'El identificador de la tarifa elegida, tal como apareció en la consulta de disponibilidad (formato habitacion:tarifa).' },
    { name: 'adultos', type: 'number', required: true, description: 'Número de adultos.' },
    { name: 'ninos', type: 'number', required: false, description: 'Número de niños.' },
    { name: 'nombre', type: 'string', required: true, description: 'Nombre completo del huésped.' },
    { name: 'email', type: 'string', required: true, description: 'Correo del huésped.' },
    { name: 'telefono', type: 'string', required: false, description: 'Teléfono del huésped.' },
    { name: 'notas', type: 'string', required: false, description: 'Peticiones especiales del cliente.' },
  ],
  async ejecutar(ctx, args) {
    const cfg = await conexion(ctx)
    if (!cfg) return SIN_CONEXION
    if (!args?.habitacion) {
      return 'Falta la habitación. Consulta primero la disponibilidad y usa el identificador que aparezca ahí.'
    }
    if (!args?.nombre || !args?.email) {
      return 'Para reservar necesito el nombre completo y el correo del cliente. Pídeselos antes de volver a llamar.'
    }
    try {
      const r = await proveedor.book(cfg, {
        checkin: args.checkin, checkout: args.checkout,
        adults: Number(args.adultos) || 1, children: Number(args.ninos) || 0,
        availability: { [args.habitacion]: 1 },
        customer: { name: args.nombre, email: args.email, phone: args.telefono || '' },
        notes: args.notas || '',
      })
      return `Reserva creada. Código: ${r.code}. Total: ${dinero(r.total, r.currency)}. ` +
        `Dale el código al cliente y confírmale las fechas ${args.checkin} → ${args.checkout}.`
    } catch (e) {
      // El motivo se le devuelve al asistente para que sepa qué hacer: si la habitación se
      // vendió, tiene que volver a consultar, no repetir la misma llamada.
      return `No se pudo crear la reserva: ${e.message}. Si la habitación ya no está disponible, vuelve a consultar disponibilidad y ofrécele otra opción.`
    }
  },
}

// ── Consultar y gestionar una reserva ─────────────────────────────────────────

const gestionar = {
  clave: 'octorateGestionarReserva',
  nombre: 'Octorate · Consultar o cancelar reserva',
  descripcion: 'Consulta el estado de una reserva por su código, o la cancela si el cliente lo pide.',
  necesitaConexion: 'octorate',
  parametros: [
    { name: 'codigo', type: 'string', required: true, description: 'Código de la reserva.' },
    { name: 'accion', type: 'enum', required: true, values: ['consultar', 'cancelar'], description: 'Qué hacer con la reserva.' },
  ],
  async ejecutar(ctx, args) {
    const cfg = await conexion(ctx)
    if (!cfg) return SIN_CONEXION
    const codigo = String(args?.codigo || '').trim()
    if (!codigo) return 'Necesito el código de la reserva.'
    try {
      if (args.accion === 'cancelar') {
        await proveedor.cancel(cfg, codigo)
        return `Reserva ${codigo} cancelada. Confírmaselo al cliente.`
      }
      const b = await proveedor.getBooking(cfg, codigo)
      return `Reserva ${b.code}: ${b.status} · ${String(b.checkin).slice(0, 10)} → ${String(b.checkout).slice(0, 10)}` +
        `${b.guest ? ` · a nombre de ${b.guest}` : ''}${b.total ? ` · ${dinero(b.total, cfg.currency)}` : ''}`
    } catch (e) {
      if (e.status === 404) return `No encontré ninguna reserva con el código ${codigo}. Pídele al cliente que lo verifique.`
      return `No se pudo consultar la reserva: ${e.message}`
    }
  },
}

// Un archivo puede exportar VARIOS handlers: el registro acepta tanto un objeto como una lista,
// y así las cuatro capacidades de Octorate viven juntas en vez de en cuatro archivos casi
// idénticos.
module.exports = [habitaciones, disponibilidad, reservar, gestionar]
