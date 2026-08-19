'use strict'
/**
 * El mensaje de cierre después de enviar recursos.
 *
 *   node pruebas/cierre-recursos.test.js
 *
 * El nodo Agente IA corta el turno cuando una herramienta ya habló por su cuenta, para no mandar
 * dos respuestas. `enviar_recurso` caía en esa regla aunque solo manda ARCHIVOS: el texto que el
 * modelo escribía después —ya sabiendo qué había salido— se descartaba sin usarlo.
 *
 * Se comprueban las DOS direcciones. Que el cierre pase tras los recursos, y que una herramienta
 * que sí habla siga cortando: sin esa segunda, el cambio reabre la respuesta duplicada que la
 * regla evitaba.
 *
 * Se dobla `aiClient.chat` y no `callAI`, para que el bucle multi-ronda que toma estas
 * decisiones sea el de verdad. (Doblar `callAI` desde fuera además no lo intercepta: el nodo usa
 * la referencia interna del módulo, no la exportada, y la llamada se iba a la API real.)
 */
const path = require('path')
const Module = require('module')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

const raiz = path.resolve(__dirname, '..')
const cargarOriginal = Module._load

// ── El guion del modelo para un turno ─────────────────────────────────────────
// Cada paso es una llamada a herramienta o el texto final.
let guion = []

const aiClienteFalso = {
  async chat() {
    const paso = guion.shift()
    if (!paso) return ''
    if (paso.herramienta) {
      return {
        message: {
          content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: paso.herramienta, arguments: JSON.stringify(paso.args || {}) } }],
        },
      }
    }
    return paso.texto || ''
  },
  detectProvider: () => 'openai',
  getApiKey: () => 'sk-de-prueba',
  OPENAI_DEFAULT: 'gpt-4o-mini',
  DEEPSEEK_DEFAULT: 'deepseek-chat',
}

// Una herramienta con código que habla por su cuenta: es el contraste. Se dobla el registro
// para no tener que dejar un handler de mentira en services/toolHandlers.
const handlersFalsos = {
  listar: () => [],
  obtener: clave => clave !== 'transferencia' ? null : {
    clave: 'transferencia',
    async ejecutar(ctx) {
      await require('../flow/common').sendBotMsg(ctx, 'Te paso con un asesor humano.')
      return 'Cliente transferido a un asesor.'
    },
  },
}

const dobles = {
  [path.join(raiz, 'db.js')]: { query: async () => [[]] },
  [path.join(raiz, 'services', 'socket.js')]: { emit() {}, emitToConv() {}, emitToMember() {} },
  [path.join(raiz, 'services', 'aiClient.js')]: aiClienteFalso,
  [path.join(raiz, 'services', 'subscriptions.js')]: { assistantGate: async () => ({ allowed: true }) },
  [path.join(raiz, 'services', 'toolHandlers', 'index.js')]: handlersFalsos,
}

Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

// Lo que se le manda al cliente, en orden.
let enviados = []
const common = require('../flow/common')
common.sendBotMsg = async (ctx, texto, extra) => {
  enviados.push({ texto, media: !!(extra && (extra.mediaId || extra.media)) })
  ctx._sentCount = (ctx._sentCount || 0) + 1
}

const ai = require('../flow/nodes/ai')
const nodoAgente = ai.aiNodes.find(n => n.type === 'ai_agent')

// ── Una cuenta con un producto de dos fotos en el CMS ─────────────────────────

const HERRAMIENTAS = [
  { id: 't_cms', name: 'Enviar recurso', description: 'Envía recursos del CMS', actionType: 'cms_resource' },
  { id: 't_hand', name: 'Transferir a asesor', description: 'Pasa el chat a un humano', actionType: 'code', handlerKey: 'transferencia' },
]

const CUENTA = {
  id: 'acc1',
  agents: [{
    id: 'ag1',
    prompts: [{ id: 'p1', isActive: true, name: 'Ventas', content: 'Eres un asesor.', toolIds: ['t_cms', 't_hand'] }],
  }],
  aiTools: HERRAMIENTAS,
  cmsFolders: [{ id: 'f1', name: 'Suites', type: 'unit', photoOrder: 'manual' }],
  cmsAssets: [
    { id: 'a1', folderId: 'f1', name: 'Suite frente', mediaId: 'm1', kind: 'image' },
    { id: 'a2', folderId: 'f1', name: 'Suite balcón', mediaId: 'm2', kind: 'image' },
  ],
}

const contexto = () => ({
  accId: 'acc1', agId: 'ag1', convId: 'conv1',
  account: CUENTA, variables: { _lastUserMessage: '¿Me muestras la suite?' },
  _sentCount: 0, debug: [],
})

const NODO = { id: 'n1', data: { promptMode: 'active' } }

async function correrTurno(pasos) {
  enviados = []
  guion = pasos
  const ctx = contexto()
  await nodoAgente.exec(NODO, ctx)
  return ctx
}

;(async () => {
  console.log('\n· Tras enviar recursos, el cierre SÍ se entrega')
  {
    const ctx = await correrTurno([
      { herramienta: 'enviar_recurso', args: { recurso: 'Suites' } },
      { texto: 'La de balcón es la que mejor te encaja por lo que me contaste.' },
    ])
    const archivos = enviados.filter(e => e.media)
    const textos = enviados.filter(e => !e.media)
    ok(archivos.length === 2, `salieron las dos fotos (${archivos.length})`)
    ok(textos.length === 1, `y UN mensaje de cierre aparte (${textos.length})`)
    ok((textos[0]?.texto || '').includes('balcón'), 'con el texto que redactó el modelo')
    ok(enviados[enviados.length - 1] === textos[0], 'y va al final, después de los archivos')
    ok(ctx._cierreTrasRecursos === true, 'la marca queda puesta durante el turno')
  }

  console.log('\n· Pero es una OPCIÓN: si el modelo calla, no se inventa nada')
  {
    await correrTurno([
      { herramienta: 'enviar_recurso', args: { recurso: 'Suites' } },
      { texto: '' },
    ])
    ok(enviados.length === 2 && enviados.every(e => e.media),
      `solo los archivos, sin mensaje de relleno (${enviados.length} mensajes)`)
  }

  console.log('\n· Contraste: una herramienta que YA habló sigue cortando el turno')
  {
    const ctx = await correrTurno([
      { herramienta: 'transferir_a_asesor' },
      { texto: 'Un asesor te atenderá enseguida.' },
    ])
    ok(enviados.length === 1, `solo el mensaje de la herramienta, sin duplicar (${enviados.length})`)
    ok(enviados[0]?.texto === 'Te paso con un asesor humano.', 'y es el suyo, no el del modelo')
    ok(!ctx._cierreTrasRecursos, 'la marca no se pone: solo la pone enviar_recurso')
  }

  console.log('\n· La marca no se arrastra de un turno al siguiente')
  {
    enviados = []
    guion = [{ herramienta: 'transferir_a_asesor' }, { texto: 'Un asesor te atenderá enseguida.' }]
    const ctx = contexto()
    ctx._cierreTrasRecursos = true            // resto de un turno anterior
    await nodoAgente.exec(NODO, ctx)
    ok(enviados.length === 1, 'el turno nuevo empieza limpio y no cuela un segundo mensaje')
  }

  console.log('\n· Al modelo se le dice que puede cerrar, y qué no hacer')
  {
    const ctx = contexto()
    const r = await ai.execToolCall(ctx, HERRAMIENTAS, 'enviar_recurso', { recurso: 'Suites' })
    ok(/cierra ahora/i.test(r), 'el resultado de la herramienta invita al cierre')
    ok(/no escribas nada/i.test(r), 'y deja claro que puede callarse')
    ok(/ya lo ve/i.test(r), 'y que no repita lo que el cliente ya está viendo')
  }

  console.log('\n· Sin archivos enviados no hay nada que cerrar')
  {
    const ctx = { ...contexto(), account: { ...CUENTA, cmsAssets: [], cmsFolders: [] } }
    const r = await ai.execToolCall(ctx, HERRAMIENTAS, 'enviar_recurso', { recurso: 'Suites' })
    ok(!/cierra ahora/i.test(r), 'no se invita al cierre si no salió ningún archivo')
    ok(!ctx._cierreTrasRecursos, 'ni se pone la marca')
  }

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
