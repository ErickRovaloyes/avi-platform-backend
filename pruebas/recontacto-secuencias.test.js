'use strict'
/**
 * Las tres generaciones de configuración de recontactos conviven en la base de datos.
 *
 *   node pruebas/recontacto-secuencias.test.js
 *
 * `normalize` tiene que leer las tres sin perder nada, porque nadie va a migrar la tabla: las
 * cuentas viejas siguen guardando el formato con el que se configuraron. Si esto falla, una
 * cuenta se queda sin recontactos y no da ningún error — simplemente deja de escribir.
 */
const path = require('path')
const Module = require('module')

// El servicio requiere la BD y el motor de flujos al cargarse; nada de eso se usa aquí.
const raiz = path.resolve(__dirname, '..')
const vacio = new Proxy({}, { get: () => () => {} })
const dobles = {
  [path.join(raiz, 'db.js')]: { query: async () => [[]] },
  [path.join(raiz, 'flow', 'store.js')]: vacio,
  [path.join(raiz, 'flow', 'common.js')]: vacio,
  [path.join(raiz, 'flow', 'engine.js')]: vacio,
  [path.join(raiz, 'services', 'calendarNotify.js')]: vacio,
  [path.join(raiz, 'controllers', 'promptGenerator.controller.js')]: vacio,
}
const cargarOriginal = Module._load
Module._load = function (pedido, padre, esPrincipal) {
  const resuelto = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (resuelto && dobles[resuelto]) return dobles[resuelto]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const { normalize, sequenceFor, sequencesForAI } = require('../services/recontact')

let fallos = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos++ }

// ── 1ª generación: un recontacto suelto ───────────────────────────────────────
console.log('\n· Formato antiguo (un solo recontacto)')
const viejo = normalize({ enabled: true, delayMinutes: 90, mode: 'intelligent', maxRecontacts: 4 })
ok(viejo.enabled === true, 'conserva que estaba activo')
ok(viejo.sequences.length === 1, 'queda en una secuencia')
ok(viejo.sequences[0].name === 'General', 'llamada «General»')
ok(viejo.sequences[0].steps[0].delayMinutes === 90, `conserva los 90 min (fue ${viejo.sequences[0].steps[0].delayMinutes})`)
ok(viejo.sequences[0].steps[0].mode === 'intelligent', 'y el modo inteligente')
ok(viejo.sequences[0].maxPerConversation === 4, `y el tope de 4 (fue ${viejo.sequences[0].maxPerConversation})`)

// ── 2ª generación: lista de pasos ─────────────────────────────────────────────
console.log('\n· Formato de pasos')
const pasos = normalize({
  enabled: true, repeat: true, maxPerConversation: 6,
  steps: [
    { delayMinutes: 60,   mode: 'flow', flowId: 'fl_1' },
    { delayMinutes: 1440, mode: 'intelligent', instructions: 'sé breve' },
  ],
})
ok(pasos.sequences.length === 1, 'queda en una secuencia')
ok(pasos.sequences[0].steps.length === 2, `conserva los 2 pasos (fueron ${pasos.sequences[0].steps.length})`)
ok(pasos.sequences[0].steps[0].flowId === 'fl_1', 'con su flujo')
ok(pasos.sequences[0].steps[1].instructions === 'sé breve', 'y sus instrucciones')
ok(pasos.sequences[0].repeat === true, 'conserva que repetía')
ok(pasos.sequences[0].maxPerConversation === 6, `y el tope de 6 (fue ${pasos.sequences[0].maxPerConversation})`)

// ── 3ª generación: varias secuencias ──────────────────────────────────────────
console.log('\n· Varias secuencias')
const nuevo = normalize({
  enabled: true,
  sequences: [
    { id: 'seq_carrito', name: 'Carrito abandonado', description: 'Dejó productos sin comprar', steps: [{ delayMinutes: 120, mode: 'flow' }], maxPerConversation: 2 },
    { id: 'seq_cita',    name: 'Cita sin confirmar', description: 'Pidió cita y no confirmó',   steps: [{ delayMinutes: 60,  mode: 'intelligent' }], maxPerConversation: 3 },
    { id: 'seq_muda',    name: 'Sin descripción',    steps: [{ delayMinutes: 30, mode: 'flow' }] },
  ],
})
ok(nuevo.sequences.length === 3, 'se guardan las tres')
ok(nuevo.sequences[1].description === 'Pidió cita y no confirmó', 'con su descripción')
ok(nuevo.sequences[0].maxPerConversation === 2 && nuevo.sequences[1].maxPerConversation === 3,
  'cada una con SU tope (2 y 3), no uno global')

console.log('\n· Elegir la secuencia de una conversación')
ok(sequenceFor(nuevo, { _recontact_seq: 'seq_cita' }).id === 'seq_cita', 'usa la que eligió el asistente')
ok(sequenceFor(nuevo, {}).id === 'seq_carrito', 'sin elección, la primera')
ok(sequenceFor(nuevo, { _recontact_seq: 'seq_borrada' }).id === 'seq_carrito',
  'si la elegida ya no existe, la primera (mejor recontactar que no hacerlo)')

console.log('\n· Lo que ve el asistente para elegir')
const paraIA = sequencesForAI(nuevo)
ok(paraIA.length === 2, `solo las que tienen descripción (fueron ${paraIA.length} de 3)`)
ok(!paraIA.some(s => s.id === 'seq_muda'), 'la que no dice para qué sirve se queda fuera')
ok(paraIA.every(s => s.id && s.name && s.description), 'y van con id, nombre y descripción')

// ── Sin configurar ────────────────────────────────────────────────────────────
console.log('\n· Cuenta sin configurar')
const nada = normalize(null)
ok(nada.enabled === false, 'sale desactivado')
ok(nada.sequences.length === 1 && nada.sequences[0].steps.length === 1, 'con una secuencia por defecto lista para editar')

console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${fallos} comprobación(es) fallida(s)\n`)
process.exit(fallos ? 1 : 0)
