'use strict'
/**
 * Entorno de pruebas: qué se copia, qué NO, y que quede desconectado.
 *
 *   node pruebas/entorno-pruebas.test.js
 *
 * Lo que se comprueba es lo que hace creíble el aislamiento:
 *   · las conversaciones y los contactos NO viajan (el entorno empieza sin gente real),
 *   · los canales entran SIN credenciales (no se le puede escribir a un cliente de verdad),
 *   · los ids de flujos y herramientas se remapean (si no, el entorno apuntaría a los de la
 *     cuenta real y editarlos ahí cambiaría producción — que es justo lo que no se quiere).
 */
const path = require('path')
const Module = require('module')

// ── Base de datos de mentira con estado por tabla ─────────────────────────────
const tablas = {
  accounts: [{ id: 'acc1', name: 'Panadería', email: 'a@b.c', plan: 'pro', status: 'active', sandbox_of: null,
               openai_key: 'sk-real', deepseek_key: '', recontact: '{"enabled":true}' }],
  agents: [{ id: 'ag1', account_id: 'acc1', name: 'Ana', status: 'active', system_prompt: 'sp', model: 'gpt-4o-mini',
             welcome_message: 'hola', prompts: '[{"id":"pr1","toolIds":["tool1"]}]',
             channels: '[{"id":"ch1","type":"whatsapp","name":"Principal","status":"connected","config":{"phoneNumberId":"111","accessToken":"SECRETO"}}]',
             rag: '{}', ai_tool_ids: '["tool1"]', created_at: 1 }],
  flows: [{ id: 'flow1', account_id: 'acc1', name: 'Bienvenida', start_node_id: 'n1',
            nodes: '[{"id":"n1","next":"flow2"}]', created_at: 1 }],
  ai_tools: [{ id: 'tool1', account_id: 'acc1', name: 'Cotizar', description: 'd', collect_fields: '[]',
               flow_id: 'flow1', action_type: 'variable', catalog_id: null, catalog_version: null }],
  labels: [{ id: 'lb1', account_id: 'acc1', name: 'VIP', color: '#f00' }],
  variables: [{ id: 'v1', account_id: 'acc1', name: 'nombre', type: 'text', default_value: '', description: '', is_system: 0 }],
  pipelines: [{ id: 'pp1', account_id: 'acc1', name: 'Ventas', stages: '[{"id":"s1"}]', cards: '[{"id":"card_real"}]' }],
  members: [{ id: 'm1', account_id: 'acc1', name: 'Erick', email: 'e@b.c', password: 'hash', avatar: null,
              role_id: 'role_owner_1', agent_access: '["ag1"]', status: 'active', created_at: 1 }],
  conversations: [{ id: 'cv1', account_id: 'acc1' }],
  contacts: [{ id: 'ct1', account_id: 'acc1' }],
  messages: [],
}

const COLS = {
  flows: ['id', 'account_id', 'name', 'start_node_id', 'nodes', 'created_at'],
  ai_tools: ['id', 'account_id', 'name', 'description', 'collect_fields', 'flow_id', 'action_type', 'catalog_id', 'catalog_version'],
  agents: ['id', 'account_id', 'name', 'status', 'system_prompt', 'model', 'welcome_message', 'prompts', 'channels', 'rag', 'ai_tool_ids', 'created_at'],
  labels: ['id', 'account_id', 'name', 'color'],
  variables: ['id', 'account_id', 'name', 'type', 'default_value', 'description', 'is_system'],
  pipelines: ['id', 'account_id', 'name', 'stages', 'cards'],
  members: ['id', 'account_id', 'name', 'email', 'password', 'avatar', 'role_id', 'agent_access', 'status', 'created_at'],
  accounts: ['id', 'name', 'email', 'plan', 'status', 'sandbox_of', 'created_at'],
}

const pool = {
  async query(sql, params = []) {
    const ins = sql.match(/^\s*INSERT INTO (\w+)/i)
    if (ins) {
      const t = ins[1]
      const cols = COLS[t] || []
      const fila = {}
      cols.forEach((c, i) => { fila[c] = params[i] })
      ;(tablas[t] ||= []).push(fila)
      return [{ affectedRows: 1 }]
    }
    const del = sql.match(/^\s*DELETE FROM (\w+)/i)
    if (del) {
      const t = del[1]
      if (/account_id=\?/.test(sql)) tablas[t] = (tablas[t] || []).filter(r => r.account_id !== params[0])
      else if (/WHERE id=\?/.test(sql)) tablas[t] = (tablas[t] || []).filter(r => r.id !== params[0])
      return [{ affectedRows: 1 }]
    }
    if (/^\s*UPDATE accounts SET openai_key/i.test(sql)) {
      const destino = tablas.accounts.find(a => a.id === params[3])
      const origen = tablas.accounts.find(a => a.id === params[0])
      if (destino && origen) Object.assign(destino, { openai_key: origen.openai_key, deepseek_key: origen.deepseek_key, recontact: origen.recontact })
      return [{ affectedRows: 1 }]
    }
    const sel = sql.match(/FROM (\w+)/i)
    if (sel) {
      const t = sel[1]
      let filas = tablas[t] || []
      if (/WHERE id=\?/.test(sql))          filas = filas.filter(r => r.id === params[0])
      else if (/WHERE sandbox_of=\?/.test(sql)) filas = filas.filter(r => r.sandbox_of === params[0])
      else if (/account_id=\?/.test(sql))   filas = filas.filter(r => r.account_id === params[0])
      return [filas]
    }
    return [[]]
  },
}

const raiz = path.resolve(__dirname, '..')
const dobles = { [path.join(raiz, 'db.js')]: pool }
const cargarOriginal = Module._load
Module._load = function (pedido, padre, esPrincipal) {
  const resuelto = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (resuelto && dobles[resuelto]) return dobles[resuelto]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const sandbox = require('../services/sandbox')

let fallos = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos++ }
const de = (t, accId) => (tablas[t] || []).filter(r => r.account_id === accId)

;(async () => {
  console.log('\n· Se crea el entorno')
  const r = await sandbox.crearOrehacer('acc1')
  const sid = r.id
  ok(r.creado === true, 'se crea por primera vez')
  ok(sid && sid !== 'acc1', `con id propio (${sid})`)
  const cuenta = tablas.accounts.find(a => a.id === sid)
  ok(cuenta?.sandbox_of === 'acc1', 'enlazada a la cuenta real')

  console.log('\n· Qué se copió')
  ok(de('agents', sid).length === 1,    'el agente')
  ok(de('flows', sid).length === 1,     'el flujo')
  ok(de('ai_tools', sid).length === 1,  'la herramienta')
  ok(de('labels', sid).length === 1,    'las etiquetas')
  ok(de('variables', sid).length === 1, 'las variables')
  ok(de('members', sid).length === 1,   'y los miembros — de ahí sale el acceso al entorno')
  ok(de('members', sid)[0].email === 'e@b.c', 'con el mismo correo, para entrar igual')

  console.log('\n· Qué NO se copió (lo que hace que sea un entorno de pruebas)')
  ok(de('conversations', sid).length === 0, 'ninguna conversación')
  ok(de('contacts', sid).length === 0,      'ningún contacto')
  ok(JSON.parse(de('pipelines', sid)[0].cards).length === 0, 'los pipelines van SIN tarjetas')

  console.log('\n· Los canales entran desconectados')
  const canales = JSON.parse(de('agents', sid)[0].channels)
  ok(canales[0].status === 'disconnected', 'marcados como desconectados')
  ok(!canales[0].config.accessToken && !canales[0].config.phoneNumberId, 'y SIN credenciales')
  ok(!JSON.stringify(canales).includes('SECRETO'), 'el token real no aparece por ningún lado')
  ok(canales[0].type === 'whatsapp', 'pero se reconoce qué canal era')

  console.log('\n· Los ids se remapean (si no, se editaría la cuenta REAL)')
  const flujoS = de('flows', sid)[0]
  const toolS  = de('ai_tools', sid)[0]
  const agenteS = de('agents', sid)[0]
  ok(flujoS.id !== 'flow1', `el flujo tiene id nuevo (${flujoS.id})`)
  ok(toolS.id !== 'tool1',  `la herramienta también (${toolS.id})`)
  ok(toolS.flow_id === flujoS.id, 'y la herramienta apunta al flujo NUEVO, no al de producción')
  ok(!agenteS.prompts.includes('tool1'), 'el prompt ya no referencia la herramienta vieja')
  ok(agenteS.prompts.includes(toolS.id), 'sino la copiada')
  ok(!JSON.parse(agenteS.ai_tool_ids).includes('tool1'), 'ni la lista de herramientas del agente')

  console.log('\n· Rehacer no duplica')
  const r2 = await sandbox.crearOrehacer('acc1')
  ok(r2.creado === false, 'reconoce que ya existía')
  ok(r2.id === sid, 'y es la misma cuenta')
  ok(de('agents', sid).length === 1, `sigue habiendo UN agente (hay ${de('agents', sid).length})`)
  ok(de('flows', sid).length === 1,  'y un flujo')

  console.log('\n· La cuenta real no se toca')
  ok(de('agents', 'acc1').length === 1 && de('agents', 'acc1')[0].id === 'ag1', 'su agente sigue igual')
  ok(JSON.parse(de('agents', 'acc1')[0].channels)[0].config.accessToken === 'SECRETO', 'con su canal conectado')
  ok(de('conversations', 'acc1').length === 1, 'y sus conversaciones intactas')

  console.log('\n· No se anidan entornos')
  let err = null
  try { await sandbox.crearOrehacer(sid) } catch (e) { err = e }
  ok(!!err, 'crear un entorno DE un entorno falla, como debe')

  console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${fallos} comprobación(es) fallida(s)\n`)
  process.exit(fallos ? 1 : 0)
})()
