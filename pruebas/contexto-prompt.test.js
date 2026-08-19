'use strict'
/**
 * El nodo «Contexto para el prompt».
 *
 *   node pruebas/contexto-prompt.test.js
 *
 * Sirve para contarle al asistente algo que él no puede ver —el texto de una plantilla de
 * WhatsApp que acaba de salir, por ejemplo— y cómo atender a partir de ahí.
 *
 * Lo que se comprueba es que el contexto LLEGA AL SYSTEM PROMPT de verdad. Guardar la variable
 * no demuestra nada: el fallo natural aquí es que se guarde bien y no se inyecte, y desde fuera
 * eso se ve igual que si el nodo no existiera.
 */
const path = require('path')
const Module = require('module')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

const raiz = path.resolve(__dirname, '..')
const cargarOriginal = Module._load

// El system prompt con el que se llamó al modelo en el último turno.
let ultimoSystem = null

const aiClienteFalso = {
  async chat({ messages }) {
    ultimoSystem = (messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n')
    return 'Vale.'
  },
  detectProvider: () => 'openai',
  getApiKey: () => 'sk-de-prueba',
  OPENAI_DEFAULT: 'gpt-4o-mini',
  DEEPSEEK_DEFAULT: 'deepseek-chat',
}

// Las variables locales de la conversación, que es donde vive el contexto entre turnos.
let locales = {}
const dobles = {
  [path.join(raiz, 'db.js')]: { query: async () => [[]] },
  [path.join(raiz, 'services', 'socket.js')]: { emit() {}, emitToConv() {}, emitToMember() {} },
  [path.join(raiz, 'services', 'aiClient.js')]: aiClienteFalso,
  [path.join(raiz, 'services', 'subscriptions.js')]: { assistantGate: async () => ({ allowed: true }) },
}
Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const store = require('../flow/store')
store.setLocalVar = async (a, g, c, clave, valor) => {
  if (valor === null || valor === undefined) delete locales[clave]
  else locales[clave] = valor
}
store.readConvos = async () => []

const common = require('../flow/common')
common.sendBotMsg = async ctx => { ctx._sentCount = (ctx._sentCount || 0) + 1 }

const ai = require('../flow/nodes/ai')
const nodoAgente = ai.aiNodes.find(n => n.type === 'ai_agent')
const nodoContexto = ai.aiNodes.find(n => n.type === 'prompt_context')

const CUENTA = {
  id: 'acc1',
  agents: [{ id: 'ag1', prompts: [{ id: 'p1', isActive: true, name: 'Ventas', content: 'Eres un asesor.', toolIds: [] }] }],
  aiTools: [],
}

/** Un contexto de ejecución que arrastra las variables locales, como en la vida real. */
const ctxNuevo = () => ({
  accId: 'acc1', agId: 'ag1', convId: 'conv1', account: CUENTA,
  variables: { _lastUserMessage: 'Hola', ...locales },
  _sentCount: 0, debug: [],
})

const fijar = data => nodoContexto.exec({ id: 'n1', data }, ctxNuevo())
const responder = () => nodoAgente.exec({ id: 'n2', data: { promptMode: 'active' } }, ctxNuevo())

const PLANTILLA = 'Se le envió la plantilla "promo_agosto": 20 % de descuento hasta el día 31.'
const COMO = 'Da por hecho que ya conoce la promoción. Si pregunta, confírmala y ofrece agendar.'

;(async () => {
  console.log('\n· Fijar el contexto lo mete en el system prompt')
  {
    locales = {}
    await fijar({ modo: 'fijar', contexto: PLANTILLA, instrucciones: COMO })
    await responder()
    ok(ultimoSystem.includes('promo_agosto'), 'el asistente ya sabe qué plantilla salió')
    ok(ultimoSystem.includes('ofrece agendar'), 'y cómo atender a partir de ahora')
    ok(ultimoSystem.includes('Eres un asesor.'), 'sin perder su prompt de siempre')
    ok(/el cliente NO lo ha escrito/i.test(ultimoSystem),
      'y se le avisa de que no lo dijo el cliente, para que no lo conteste como si fuera un mensaje')
  }

  console.log('\n· «Hasta limpiarlo» aguanta los turnos siguientes')
  {
    ultimoSystem = ''
    await responder()
    ok(ultimoSystem.includes('promo_agosto'), 'sigue ahí en el segundo turno')
    ultimoSystem = ''
    await responder()
    ok(ultimoSystem.includes('promo_agosto'), 'y en el tercero')
  }

  console.log('\n· Limpiar lo quita')
  {
    await fijar({ modo: 'limpiar' })
    ultimoSystem = ''
    await responder()
    ok(!ultimoSystem.includes('promo_agosto'), 'ya no se inyecta')
    ok(ultimoSystem.includes('Eres un asesor.'), 'y el prompt normal sigue intacto')
  }

  console.log('\n· «Solo la próxima ejecución» se gasta al usarse')
  {
    locales = {}
    await fijar({ modo: 'fijar', duracion: 'siguiente', contexto: 'El cliente viene de un anuncio de Instagram.' })
    ultimoSystem = ''
    await responder()
    ok(ultimoSystem.includes('anuncio de Instagram'), 'se usa una vez')
    ultimoSystem = ''
    await responder()
    ok(!ultimoSystem.includes('anuncio de Instagram'), 'y en el turno siguiente ya no está')
  }

  console.log('\n· La caducidad')
  {
    locales = {}
    await fijar({ modo: 'fijar', contexto: 'Promoción de hoy.', caduca_horas: 2 })
    ultimoSystem = ''
    await responder()
    ok(ultimoSystem.includes('Promoción de hoy'), 'dentro del plazo se inyecta')

    // Se envejece a mano en vez de esperar dos horas.
    locales._promptContext = { ...locales._promptContext, hasta: Date.now() - 1000 }
    ultimoSystem = ''
    await responder()
    ok(!ultimoSystem.includes('Promoción de hoy'), 'pasado el plazo, no')
  }
  {
    locales = {}
    await fijar({ modo: 'fijar', contexto: 'Sin caducidad.' })
    ok(locales._promptContext?.hasta === null, 'sin horas, no caduca')
  }

  console.log('\n· Contraste: sin contexto fijado, el prompt no cambia')
  {
    locales = {}
    ultimoSystem = ''
    await responder()
    ok(!/CONTEXTO AÑADIDO/i.test(ultimoSystem), 'no aparece ningún bloque de contexto')
  }

  console.log('\n· Detalles que evitan sorpresas')
  {
    locales = {}
    await fijar({ modo: 'fijar', contexto: '   ', instrucciones: '' })
    ok(!locales._promptContext, 'un nodo vacío no guarda nada (si no, quedaría un bloque en blanco)')

    locales = {}
    await fijar({ modo: 'fijar', contexto: 'Compró el plan {{plan}}.' })
    const ctx = ctxNuevo()
    ctx.variables.plan = 'Premium'
    await nodoContexto.exec({ id: 'n1', data: { modo: 'fijar', contexto: 'Compró el plan {{plan}}.' } }, ctx)
    ok(String(locales._promptContext?.contexto || '').includes('Premium'),
      `las variables se interpolan (${locales._promptContext?.contexto})`)

    locales = {}
    await fijar({ modo: 'limpiar' })
    ok(!locales._promptContext, 'limpiar sin nada fijado no rompe')
  }

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
