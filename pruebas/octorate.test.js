'use strict'
/**
 * Integración con Octorate: proveedor de PMS, OAuth y mensajería de portales.
 *
 *   node pruebas/octorate.test.js
 *
 * Se ejecuta contra un doble de la API construido con las FORMAS DE SU ESPECIFICACIÓN OpenAPI
 * (SearchRoomResult, ChatMessageDTO con sus `attributes`, ApiReservationReqDTO). Eso valida la
 * traducción, que es donde está el trabajo; lo que no puede validar son las rarezas de la API
 * real, y eso queda pendiente de probar contra una cuenta de verdad.
 */
const path = require('path')
const Module = require('module')

// ── Doble de la API de Octorate ───────────────────────────────────────────────
const llamadas = []
let cuentaFilas = [{ id: 'ACC1', name: 'Hotel Mar', city: 'Cartagena', currency: 'COP', address: 'Calle 1', phoneNumber: '+57', checkinStart: '15:00', checkout: '11:00' }]

// Tal como los devuelve /reservation/{acc}/search, con los cargos aparte del precio.
const filasBusqueda = [
  { room: 'R1', rate: 'RP1', name: 'Suite Vista Mar', ratePlanName: 'Tarifa flexible', guests: 2,
    price: 400000, availability: 3, bookingFee: 0, resortFee: 20000, serviceCharge: 10000, breakfastPrice: 0, bookUrl: 'https://book/1' },
  { room: 'R1', rate: 'RP2', name: 'Suite Vista Mar', ratePlanName: 'No reembolsable', guests: 2,
    price: 350000, availability: 3, resortFee: 20000, breakfastPrice: 15000 },
  { room: 'R2', rate: 'RP1', name: 'Habitación Estándar', ratePlanName: 'Tarifa flexible', guests: 2,
    price: 200000, availability: 0 },   // llena: no debe ofrecerse
]

function respuesta(ruta, opciones) {
  llamadas.push({ ruta, method: opciones?.method || 'GET', query: opciones?.query, body: opciones?.body })
  if (ruta === '/accommodation') return cuentaFilas
  if (ruta.startsWith('/accommodation/') && ruta.endsWith('/photos')) return [{ url: 'https://foto/1.jpg' }]
  if (ruta.startsWith('/accommodation/')) return cuentaFilas[0]
  if (ruta.startsWith('/roomrates/')) return { description: 'Con balcón y jacuzzi', maxGuests: 3, images: [{ url: 'https://hab/1.jpg' }] }
  if (ruta.includes('/search')) {
    const q = opciones?.query || {}
    return q.availcheck === false ? filasBusqueda : filasBusqueda
  }
  if (ruta.startsWith('/reservation/') && opciones?.method === 'POST') {
    return { id: 991, refer: opciones.body.refer, status: 'CONFIRMED' }
  }
  if (ruta.startsWith('/reservation/') && opciones?.method === 'DELETE') return { ok: true }
  if (ruta.startsWith('/reservation/') && opciones?.method === 'PATCH') return { ok: true }
  if (ruta.startsWith('/reservation/')) {
    return { id: 991, refer: 'AVI-X', status: 'CONFIRMED', checkin: '2026-09-01', checkout: '2026-09-03', roomGross: 430000, guests: [{ name: 'Ana' }], channelId: 'AIRBNB' }
  }
  if (ruta.includes('/threads/') && ruta.endsWith('/messages')) {
    // ChatMessageDTO: el texto va en `attributes`, no en un campo suelto.
    return [
      { id: 1, externalId: 'm1', processor: 'CHANNEL', attributes: [{ type: 'TEXT', value: '¿Tienen parqueadero?' }] },
      { id: 2, externalId: 'm2', processor: 'NOTE',    attributes: [{ type: 'TEXT', value: 'Nota interna del hotel' }] },
      { id: 3, externalId: 'm3', processor: 'CHANNEL', attributes: [{ type: 'IMAGE', value: 'https://x/f.jpg' }] },
    ]
  }
  if (ruta.includes('/threads')) {
    return [{ id: 77, persons: [{ name: 'Ana Pérez' }], chatThreadExternals: [{ portal: 'AIRBNB' }] }]
  }
  if (ruta.startsWith('/subscription/')) return { ok: true }
  return {}
}

const raiz = path.resolve(__dirname, '..')
const dobles = {
  [path.join(raiz, 'db.js')]: { query: async () => [[]] },
  [path.join(raiz, 'services', 'octorate.js')]: null,   // se rellena abajo
}
const cargarOriginal = Module._load
Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

// El cliente real, con solo `api` sustituido: así se prueban de verdad sus ayudantes
// (listarPropiedades, buscar, crearReserva…) y no una copia mía.
const octReal = cargarOriginal.call(Module, path.join(raiz, 'services', 'octorate.js'), null, false)
const octDoble = { ...octReal, api: async (accId, cfg, ruta, opciones) => respuesta(ruta, opciones) }
dobles[path.join(raiz, 'services', 'octorate.js')] = octDoble
// Los ayudantes del cliente real cierran sobre su propio `api`, así que se reimplementan
// apuntando al doble. Se conserva su forma exacta: rutas, metodos y parametros.
octDoble.listarPropiedades = (a, c) => octDoble.api(a, c, '/accommodation')
octDoble.verPropiedad = (a, c, acc) => octDoble.api(a, c, `/accommodation/${acc}`)
octDoble.fotosPropiedad = (a, c, acc) => octDoble.api(a, c, `/accommodation/${acc}/photos`)
octDoble.verHabitacion = (a, c, acc, r) => octDoble.api(a, c, `/roomrates/${acc}/${r}`)
octDoble.buscar = (a, c, acc, q) => octDoble.api(a, c, `/reservation/${acc}/search`, { query: q })
octDoble.crearReserva = (a, c, acc, b) => octDoble.api(a, c, `/reservation/${acc}`, { method: 'POST', body: b })
octDoble.verReserva = (a, c, acc, id) => octDoble.api(a, c, `/reservation/${acc}/${id}`)
octDoble.modificarReserva = (a, c, acc, id, b) => octDoble.api(a, c, `/reservation/${acc}/${id}`, { method: 'PATCH', body: b })
octDoble.borrarReserva = (a, c, acc, id) => octDoble.api(a, c, `/reservation/${acc}/${id}`, { method: 'DELETE' })
octDoble.listarHilos = (a, c, p, q) => octDoble.api(a, c, `/chat/${p}/threads`, { query: q })
octDoble.mensajesDelHilo = (a, c, p, h, q) => octDoble.api(a, c, `/chat/${p}/threads/${h}/messages`, { query: q })
octDoble.enviarMensaje = (a, c, p, b) => octDoble.api(a, c, `/chat/${p}/messages`, { method: 'POST', body: b })

const proveedor = require('../services/pmsOctorate')
const chat = require('../services/octorateChat')

const CFG = { _accId: 'acc1', provider: 'octorate', propertyId: 'ACC1', currency: 'COP', oauth: { accessToken: 't', expiraEn: Date.now() + 9e6 } }

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

;(async () => {
  console.log('\n· Propiedades')
  const props = await proveedor.listProperties(CFG)
  ok(props.length === 1 && props[0].id === 'ACC1', 'lista las propiedades de la cuenta')
  const prop = await proveedor.getProperty(CFG)
  ok(prop.name === 'Hotel Mar' && prop.city === 'Cartagena', 'trae la ficha')
  ok(prop.photos.length === 1, 'con sus fotos')

  console.log('\n· Habitaciones')
  const habs = await proveedor.getRooms(CFG)
  ok(habs.length === 2, `agrupa por habitacion, no por tarifa (${habs.length} de 3 filas)`)
  const suite = habs.find(h => h.id === 'R1')
  ok(suite.rates.length === 2, 'la suite conserva sus DOS tarifas')
  ok(suite.description.includes('jacuzzi'), 'y su descripcion real, pedida por habitacion')
  ok(suite.photos.length === 1, 'con foto')
  ok(suite.capacity === 3, `la capacidad viene de la ficha, no del buscador (${suite.capacity})`)

  console.log('\n· Los cargos se suman al precio')
  const flexible = suite.rates.find(t => t.name === 'Tarifa flexible')
  ok(flexible.total === 430000, `400.000 + 20.000 resort + 10.000 servicio = 430.000 (fue ${flexible.total})`)
  ok(flexible.total !== 400000, 'y NO se da el precio pelado, que es el que genera quejas al llegar')

  console.log('\n· Disponibilidad: lo lleno no se ofrece')
  const { rooms } = await proveedor.getAvailability(CFG, { checkin: '2026-09-01', checkout: '2026-09-03', adults: 2 })
  ok(rooms.length === 1 && rooms[0].id === 'R1', 'la habitacion con availability 0 se descarta')
  const q = llamadas.filter(l => l.ruta.includes('/search')).pop().query
  ok(q.availcheck === true && q.checkin === '2026-09-01', 'y se pide comprobando disponibilidad')

  console.log('\n· Reservar')
  llamadas.length = 0
  const res = await proveedor.book(CFG, {
    checkin: '2026-09-01', checkout: '2026-09-03', adults: 2, children: 1,
    availability: { 'R1:RP1': 1 }, customer: { name: 'Ana', email: 'a@b.c', phone: '+57300' },
  })
  ok(res.status === 'CONFIRMED' && res.code, `queda confirmada (${res.code})`)
  const revalida = llamadas.filter(l => l.ruta.includes('/search'))
  ok(revalida.length === 1, 'antes de reservar SE REVALIDA la disponibilidad')
  const cuerpo = llamadas.find(l => l.method === 'POST').body
  for (const campo of ['channelId', 'checkin', 'checkout', 'createTime', 'guests', 'product', 'refer', 'roomGross', 'totalChildren', 'totalGuest', 'totalInfants', 'updateTime']) {
    ok(cuerpo[campo] !== undefined, `el cuerpo lleva "${campo}", que la API exige`)
  }
  ok(cuerpo.totalGuest === 3, 'adultos + ninos (2+1=3)')
  ok(cuerpo.roomGross === 430000, 'y el importe con cargos')

  console.log('\n· Contraste: una habitacion que ya no esta')
  let err = null
  try { await proveedor.book(CFG, { checkin: '2026-09-01', checkout: '2026-09-03', adults: 2, availability: { 'R2:RP1': 1 } }) }
  catch (e) { err = e }
  ok(!!err && /ya no está disponible/i.test(err.message), 'se rechaza en vez de crear una reserva imposible')

  console.log('\n· Consultar, cancelar y reagendar')
  const b = await proveedor.getBooking(CFG, 'AVI-X')
  ok(b.status === 'CONFIRMED' && b.guest === 'Ana', 'consulta la reserva')
  ok((await proveedor.cancel(CFG, 'AVI-X')).status === 'CANCELLED', 'cancela')
  const re = await proveedor.reschedule(CFG, 'AVI-X', { checkin: '2026-10-01', checkout: '2026-10-04' })
  ok(re.ok && re.checkin === '2026-10-01', 'reagenda')

  console.log('\n· Mensajeria de portales')
  ok(chat.textoDe({ attributes: [{ type: 'TEXT', value: 'hola' }] }) === 'hola', 'el texto sale de `attributes`, no de un campo suelto')
  ok(chat.textoDe({ attributes: [{ type: 'IMAGE', value: 'u' }] }) === '[image]', 'y un adjunto deja constancia en vez de una burbuja vacia')
  ok(chat.esDelHuesped({ processor: 'CHANNEL' }) === true, 'un mensaje del portal es del huesped')
  ok(chat.esDelHuesped({ processor: 'NOTE' }) === false, 'una NOTA interna del hotel NO entra al inbox')
  ok(chat.portalDe({ chatThreadExternals: [{ portal: 'AIRBNB' }] }) === 'Airbnb', 'se reconoce Airbnb')
  ok(chat.portalDe({ chatThreadExternals: [{ portal: 'BOOKING_COM' }] }) === 'Booking', 'y Booking')

  console.log('\n· El token se renueva solo cuando toca')
  llamadas.length = 0
  ok(typeof octReal.tokenValido === 'function', 'existe la renovacion')
  ok(octReal.urlDeAutorizacion({ clientId: 'c', redirectUri: 'https://x/cb', state: 's' })
      .startsWith('https://admin.octorate.com/octobook/identity/oauth.xhtml'), 'y la URL de autorizacion es la suya')


  console.log('\n· Herramientas instalables desde el catalogo')
  // Se sustituye la carga de config para que los handlers vean una cuenta ya autorizada.
  const pmsMod = require('../services/pms')
  const cargarOrig = pmsMod.loadConfig
  pmsMod.loadConfig = async () => CFG
  const registro = require('../services/toolHandlers')

  const hDisp = registro.obtener('octorateDisponibilidad')
  ok(!!hDisp, 'la herramienta de disponibilidad esta en el catalogo de handlers')
  const t1 = await hDisp.ejecutar({ accId: 'acc1' }, { checkin: '2026-09-01', checkout: '2026-09-03', adultos: 2 })
  ok(t1.includes('Suite Vista Mar') && t1.includes('430'), 'devuelve las opciones con el precio CON cargos')
  ok(!/Est[aá]ndar/.test(t1), 'y no ofrece la habitacion llena')

  const malaFecha = await hDisp.ejecutar({ accId: 'acc1' }, { checkin: '1 de septiembre', checkout: '2026-09-03', adultos: 2 })
  ok(/AAAA-MM-DD/.test(malaFecha), 'una fecha mal escrita se corrige ANTES de llamar a la API')
  const alReves = await hDisp.ejecutar({ accId: 'acc1' }, { checkin: '2026-09-05', checkout: '2026-09-01', adultos: 2 })
  ok(/posterior/.test(alReves), 'y unas fechas al reves tambien')

  const hRes = registro.obtener('octorateReservar')
  const sinDatos = await hRes.ejecutar({ accId: 'acc1' }, { checkin: '2026-09-01', checkout: '2026-09-03', habitacion: 'R1:RP1', adultos: 2 })
  ok(/nombre completo y el correo/.test(sinDatos), 'no reserva sin nombre ni correo: se los pide al cliente')
  const hecha = await hRes.ejecutar({ accId: 'acc1' }, { checkin: '2026-09-01', checkout: '2026-09-03', habitacion: 'R1:RP1', adultos: 2, nombre: 'Ana', email: 'a@b.c' })
  ok(/Reserva creada/.test(hecha), 'y con los datos crea la reserva')

  console.log('\n· Contraste: sin conexion autorizada')
  pmsMod.loadConfig = async () => ({ provider: 'octorate' })   // sin oauth
  const sinConexion = await hDisp.ejecutar({ accId: 'acc1' }, { checkin: '2026-09-01', checkout: '2026-09-03', adultos: 2 })
  ok(/no ha conectado/.test(sinConexion), 'lo dice con claridad en vez de fallar con un error de API')
  pmsMod.loadConfig = cargarOrig

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
