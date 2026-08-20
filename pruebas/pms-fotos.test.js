'use strict'
/**
 * Que el asistente no reenvíe fotos del PMS una y otra vez.
 *
 *   node pruebas/pms-fotos.test.js
 *
 * El fallo, tal como se veía: pides fotos por Kunas, llegan, y a partir de ahí digas lo que
 * digas te siguen llegando fotos. La causa eran tres piezas empujándose:
 *
 *   1. Al enviar fotos, el nodo daba el turno por contestado y TIRABA el texto del modelo, así
 *      que tras las fotos el asistente se quedaba mudo.
 *   2. Como no dijo nada, en el historial no quedaba ni una palabra suya sobre lo enviado —solo
 *      turnos «[enviado: imagen]»—, y la conversación de herramientas no entra en el historial.
 *   3. El prompt del sistema le prohibía afirmar que ya había hecho algo sin invocar la función
 *      «en ESTE turno». Para poder mencionar las fotos, volvía a llamar. Y la herramienta,
 *      obediente, mandaba la tanda siguiente.
 *
 * Con Kunas se notaba más porque trae muchas fotos por tipo de habitación: la rueda giraba
 * durante muchos turnos antes de agotarse.
 */
const path = require('path')
const Module = require('module')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

const raiz = path.resolve(__dirname, '..')
const cargarOriginal = Module._load

// ── El guion del modelo ───────────────────────────────────────────────────────
let guion = []
const aiClienteFalso = {
  async chat() {
    const paso = guion.shift()
    if (!paso) return ''
    if (paso.herramienta) {
      return { message: { content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: paso.herramienta, arguments: JSON.stringify(paso.args || {}) } }] } }
    }
    return paso.texto || ''
  },
  detectProvider: () => 'openai',
  getApiKey: () => 'sk-de-prueba',
  OPENAI_DEFAULT: 'gpt-4o-mini',
  DEEPSEEK_DEFAULT: 'deepseek-chat',
}

// Lo que devuelve el PMS. Se controla desde cada caso.
let respuestaPms = { text: 'Hecho.' }
const pmsFalso = {
  toolCall: async () => respuestaPms,
  loadConfig: async () => ({}),
}

const dobles = {
  [path.join(raiz, 'db.js')]: { query: async () => [[]] },
  [path.join(raiz, 'services', 'socket.js')]: { emit() {}, emitToConv() {}, emitToMember() {} },
  [path.join(raiz, 'services', 'aiClient.js')]: aiClienteFalso,
  [path.join(raiz, 'services', 'subscriptions.js')]: { assistantGate: async () => ({ allowed: true }) },
  [path.join(raiz, 'services', 'pms.js')]: pmsFalso,
}
Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

let enviados = []
const common = require('../flow/common')
common.sendBotMsg = async (ctx, texto, extra) => {
  enviados.push({ texto, media: !!(extra && (extra.mediaId || extra.media)) })
  ctx._sentCount = (ctx._sentCount || 0) + 1
}

const ai = require('../flow/nodes/ai')
const nodoAgente = ai.aiNodes.find(n => n.type === 'ai_agent')

const HERRAMIENTAS = [{ id: 't_pms', name: 'PMS', description: 'Hotel', actionType: 'pms' }]
const CUENTA = {
  id: 'acc1',
  agents: [{ id: 'ag1', prompts: [{ id: 'p1', isActive: true, name: 'Hotel', content: 'Eres recepcionista.', toolIds: ['t_pms'] }] }],
  aiTools: HERRAMIENTAS,
  pms: { connected: true, hotelName: 'Hotel Mar' },
}
const contexto = () => ({
  accId: 'acc1', agId: 'ag1', convId: 'conv1',
  account: CUENTA, variables: { _lastUserMessage: 'mándame fotos' },
  _sentCount: 0, debug: [],
})
const NODO = { id: 'n1', data: { promptMode: 'active' } }

async function correr(pasos, pms) {
  enviados = []
  guion = pasos
  respuestaPms = pms
  const ctx = contexto()
  await nodoAgente.exec(NODO, ctx)
  return ctx
}

const CON_FOTOS = {
  text: 'Envié 4 foto(s) de Hotel Mar al cliente. Quedan 12 foto(s) más si el cliente quiere ver otras.',
  media: [{ url: 'a.jpg', caption: 'Hotel Mar' }, { url: 'b.jpg' }, { url: 'c.jpg' }, { url: 'd.jpg' }],
}
const SIN_FOTOS = { text: 'Reserva confirmada con el código ABC123.', booked: true, bookingCode: 'ABC123' }

;(async () => {
  console.log('\n· Tras enviar fotos, el asistente SÍ habla')
  {
    const ctx = await correr(
      [{ herramienta: 'ver_habitaciones', args: { fotos: true } },
       { texto: 'Ahí tienes la Suite Vista Mar. ¿Te miro disponibilidad para tus fechas?' }],
      CON_FOTOS)
    const fotos = enviados.filter(e => e.media)
    const textos = enviados.filter(e => !e.media)
    ok(fotos.length === 4, `salen las cuatro fotos (${fotos.length})`)
    ok(textos.length === 1, `y UN mensaje de texto detrás (${textos.length})`)
    ok((textos[0]?.texto || '').includes('Suite Vista Mar'), 'con lo que escribió el modelo')
    ok(ctx._cierreTrasRecursos === true, 'la marca de «puede cerrar» queda puesta')
  }

  console.log('\n· Contraste: si el PMS no mandó fotos, no se duplica la respuesta')
  {
    // Una reserva SÍ es la respuesta completa: ahí el corte del turno sigue siendo correcto.
    const ctx = await correr(
      [{ herramienta: 'reservar_habitacion', args: {} }, { texto: 'Listo, ya quedó reservada.' }],
      SIN_FOTOS)
    ok(!ctx._cierreTrasRecursos, 'no se marca cierre cuando no hubo fotos')
    ok(enviados.filter(e => !e.media).length === 1,
      `y solo sale un texto, el del modelo (${enviados.filter(e => !e.media).length})`)
  }

  console.log('\n· El prompt ya no le obliga a repetir para poder mencionarlo')
  {
    // Se lee el texto que ai.js mete en el system prompt cuando hay herramientas.
    const fuente = require('fs').readFileSync(path.join(raiz, 'flow', 'nodes', 'ai.js'), 'utf8')
    const i = fuente.indexOf('USO OBLIGATORIO DE HERRAMIENTAS')
    const bloque = fuente.slice(i, i + 2600)

    ok(/PROHIBIDO afirmar que ACABAS de hacer algo/.test(bloque),
      'lo prohibido es fingir que acabas de hacerlo AHORA')
    ok(/puedes darlo por hecho y referirte a ello con normalidad/.test(bloque),
      'y se le permite EXPRESAMENTE hablar de lo que ya envió antes')
    ok(/SIN volver a invocar nada/.test(bloque),
      'diciéndole que para eso no hace falta volver a llamar a la herramienta')
    ok(/Repetir una acción que el usuario no ha vuelto a pedir es un error/.test(bloque),
      'y que repetir sin que se lo pidan es un error, no una precaución')

    // EL contraste: la redacción anterior es la que causó esto.
    const redaccionVieja = 'PROHIBIDO afirmar que ya hiciste algo ("ya lo envié", "lo guardé"'
    ok(!bloque.includes(redaccionVieja),
      'y ya NO está la redacción que le obligaba a reinvocar para poder mencionarlo')
  }

  console.log('\n· El cursor de fotos, ejercitado de verdad')
  {
    // Se carga el servicio SIN el doble, para usar el `sendPhotoBatch` real.
    const pmsReal = cargarOriginal.call(Module, path.join(raiz, 'services', 'pms.js'), null, false)
    const pool = ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg']
    const clave = `conv-prueba:${Date.now()}`

    const a = pmsReal.sendPhotoBatch(pool, clave, { maxPhotos: 4, label: 'Hotel Mar' })
    ok(a.media?.length === 4, `la primera tanda manda cuatro (${a.media?.length})`)
    ok(!/acabas de enviar fotos/.test(a.text), 'y en la PRIMERA no hay aviso: nadie ha repetido nada')

    const b = pmsReal.sendPhotoBatch(pool, clave, { maxPhotos: 4 })
    ok(/acabas de enviar fotos hace un momento/.test(b.text), 'la segunda seguida SÍ lleva el aviso')
    ok(/salvo que el cliente las pida expresamente/.test(b.text), 'y es un aviso, no un cerrojo')
    ok(b.media?.length === 2, `manda las que faltaban, no las mismas (${b.media?.length})`)
    const repetidas = (b.media || []).filter(m => ['1.jpg', '2.jpg', '3.jpg', '4.jpg'].includes(m.url))
    ok(repetidas.length === 0, `sin repetir ninguna de la tanda anterior (${repetidas.length})`)

    const c = pmsReal.sendPhotoBatch(pool, clave, { maxPhotos: 4 })
    ok(!c.media, 'agotadas, ya no manda más')
    ok(/Ya te envié todas/.test(c.text), 'y lo dice, en vez de empezar otra vez por el principio')

    // Pedirlas a propósito sigue funcionando: era la condición de no poner un cerrojo.
    const d = pmsReal.sendPhotoBatch(pool, clave, { maxPhotos: 4, reset: true })
    ok(d.media?.length === 4, `con «desde el inicio» vuelven a salir (${d.media?.length})`)

    // El cursor es por conversación: otra no hereda ni el aviso ni lo enviado.
    const otra = pmsReal.sendPhotoBatch(pool, `otra-conv:${Date.now()}`, { maxPhotos: 4 })
    ok(!/acabas de enviar fotos/.test(otra.text), 'otra conversación empieza limpia')
    ok(otra.media?.length === 4, 'y recibe su primera tanda entera')
  }

  console.log('\n· El aviso es por «hace un momento», no por «alguna vez»')
  {
    // Si alguien vuelve al rato y pide más fotos, no hay nada que avisar: no está repitiendo.
    //
    // Este caso es el que distingue leer la marca de tiempo ANTES o DESPUÉS de `photoState`:
    // esa función refresca `at` a ahora, así que leyéndola después TODA tanda anterior parecería
    // reciente y el aviso saldría siempre. Con las dos llamadas seguidas el resultado es el
    // mismo, por eso hace falta mover el reloj.
    const pmsReal = cargarOriginal.call(Module, path.join(raiz, 'services', 'pms.js'), null, false)
    const pool = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']
    const clave = `conv-tiempo:${Date.now()}`
    const ahoraReal = Date.now

    pmsReal.sendPhotoBatch(pool, clave, { maxPhotos: 2 })
    try {
      const t = ahoraReal.call(Date)
      Date.now = () => t + 5 * 60 * 1000      // cinco minutos después
      const tarde = pmsReal.sendPhotoBatch(pool, clave, { maxPhotos: 2 })
      ok(!/acabas de enviar fotos/.test(tarde.text),
        'pasados unos minutos NO se avisa: pedir más entonces es normal, no una repetición')
      ok(tarde.media?.length === 2, `y las fotos siguen llegando (${tarde.media?.length})`)
    } finally { Date.now = ahoraReal }
  }

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
