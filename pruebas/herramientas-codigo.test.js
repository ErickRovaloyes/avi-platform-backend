'use strict'
/**
 * Herramientas del catalogo con codigo propio, y parametros con tipo.
 *
 *   node pruebas/herramientas-codigo.test.js
 *
 * Dos cosas:
 *   · el registro de handlers descubre lo que hay en la carpeta (nada de listas a mano), y una
 *     ficha que apunta a un handler inexistente NO puede tumbar la conversacion del cliente,
 *   · los parametros con tipo llegan al modelo como tales; y lo mas importante, las
 *     herramientas de siempre —las de `collectFields`— siguen generando exactamente lo mismo.
 */
const path = require('path')
const Module = require('module')

const raiz = path.resolve(__dirname, '..')
const vacio = new Proxy({}, { get: () => () => {} })
const dobles = {
  [path.join(raiz, 'db.js')]: { query: async () => [[]] },
  [path.join(raiz, 'flow', 'store.js')]: { ...vacio, setLocalVar: async () => {}, loadAccount: async () => null },
  [path.join(raiz, 'flow', 'common.js')]: vacio,
  [path.join(raiz, 'flow', 'engine.js')]: vacio,
}
const cargarOriginal = Module._load
Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const registro = require('../services/toolHandlers')
const ai = require('../flow/nodes/ai')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

;(async () => {
  console.log('\n· El registro descubre los handlers de la carpeta')
  const lista = registro.listar()
  ok(lista.length > 0, 'encuentra al menos uno (' + lista.length + ')')
  ok(lista.some(h => h.clave === 'ejemploCotizadorEnvio'), 'incluye el de ejemplo')
  ok(lista.every(h => h.clave && h.nombre), 'todos traen clave y nombre para el superpanel')
  ok(registro.obtener('noExisteEsteHandler') === null, 'y una clave inexistente devuelve null, no revienta')

  console.log('\n· El handler se ejecuta y devuelve texto para el asistente')
  const h = registro.obtener('ejemploCotizadorEnvio')
  const salida = await h.ejecutar({}, { ciudad: 'Bogota', peso_kg: 2, urgente: false })
  ok(typeof salida === 'string' && salida.includes('TOTAL'), 'cotiza y devuelve texto legible')
  const malo = await h.ejecutar({}, { ciudad: 'Narnia', peso_kg: 2 })
  ok(malo.includes('bogota'), 'y ante una ciudad desconocida DICE cuales hay, para que el modelo no invente')
  const sinPeso = await h.ejecutar({}, { ciudad: 'Bogota' })
  ok(sinPeso.includes('peso'), 'valida lo que llega: el modelo tambien se equivoca')

  console.log('\n· Parametros CON tipo')
  const def = ai.buildToolDefs([{
    name: 'Cotizar envio', description: 'd', actionType: 'code', handlerKey: 'ejemploCotizadorEnvio',
    parameters: [
      { name: 'ciudad', type: 'enum', values: ['bogota', 'cali'], required: true, description: 'Destino' },
      { name: 'peso_kg', type: 'number', required: true, description: 'Peso' },
      { name: 'urgente', type: 'boolean', required: false, description: 'Urgencia' },
    ],
  }], {})[0]
  const props = def.function.parameters.properties
  ok(props.peso_kg.type === 'number', 'un numero se declara como numero (' + props.peso_kg.type + ')')
  ok(props.urgente.type === 'boolean', 'un booleano como booleano (' + props.urgente.type + ')')
  ok(props.ciudad.type === 'string' && Array.isArray(props.ciudad.enum), 'y un enum como string con sus valores')
  ok(props.ciudad.enum.join(',') === 'bogota,cali', 'con los valores correctos')
  ok(def.function.parameters.required.join(',') === 'ciudad,peso_kg', 'solo los obligatorios son required')
  ok(def.function.name === 'cotizar_envio', 'el nombre se normaliza (espacios a guion bajo)')

  console.log('\n· Contraste: las herramientas de siempre no cambian')
  const vieja = ai.buildToolDefs([{
    name: 'Pedir datos', description: 'd', actionType: 'variable',
    collectFields: [{ label: 'Nombre completo', variableId: 'v1' }, { label: 'Correo', required: false }],
  }], {})[0]
  const pv = vieja.function.parameters.properties
  ok(Object.keys(pv).join(',') === 'nombre_completo,correo', 'los campos siguen dando los mismos nombres')
  ok(pv.nombre_completo.type === 'string' && pv.correo.type === 'string', 'y siguen siendo cadenas')
  ok(vieja.function.parameters.required.join(',') === 'nombre_completo', 'con la misma regla de obligatorios')
  ok(vieja.function.name === 'pedir_datos', 'y el nombre se normaliza igual')

  console.log('\n· Una ficha que apunta a un handler que ya no existe')
  const ctx = { accId: 'a', agId: 'b', convId: 'c' }
  const r = await ai.execToolCall(ctx, [{ name: 'Rota', description: 'd', actionType: 'code', handlerKey: 'noExiste' }], 'rota', {})
  ok(typeof r === 'string', 'devuelve un texto en vez de lanzar')
  ok(r.includes('Rota'), 'nombrando la herramienta: ' + JSON.stringify(r.slice(0, 70)))

  console.log('\n· Y una que si existe, se ejecuta de verdad')
  const r2 = await ai.execToolCall(ctx, [{
    name: 'Cotizar envio', description: 'd', actionType: 'code', handlerKey: 'ejemploCotizadorEnvio',
  }], 'cotizar_envio', { ciudad: 'cali', peso_kg: 1 })
  ok(r2.includes('TOTAL'), 'el resultado del handler llega al asistente')

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
