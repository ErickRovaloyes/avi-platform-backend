'use strict'
/**
 * El permiso «solo chats asignados».
 *
 *   node pruebas/visibilidad-convos.test.js
 *
 * Un permiso que solo se aplicara en el navegador no restringiría nada: bastaría con llamar al
 * endpoint. Así que se comprueban los CUATRO frentes, porque con que uno se quede atrás el
 * permiso deja de valer:
 *
 *   1. la lista            3. las escrituras
 *   2. el chat suelto      4. el reparto por socket
 *
 * El cuarto es el que más se olvida: los mensajes salen a la sala `acc:{id}`, que alcanza a
 * TODOS los miembros, así que filtrar solo en la API dejaría los ajenos llegando en tiempo real.
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

const raiz = path.resolve(__dirname, '..')
const cargarOriginal = Module._load

// ── Datos ─────────────────────────────────────────────────────────────────────

const CONVS = [
  { id: 'c1', account_id: 'acc1', agent_id: 'ag1', assigned_to: JSON.stringify({ id: 'mem_ana', name: 'Ana' }), team_id: null, updated_at: 3 },
  { id: 'c2', account_id: 'acc1', agent_id: 'ag1', assigned_to: null, team_id: 'team_ventas', updated_at: 2 },
  { id: 'c3', account_id: 'acc1', agent_id: 'ag1', assigned_to: JSON.stringify({ id: 'mem_beto', name: 'Beto' }), team_id: null, updated_at: 1 },
  { id: 'c4', account_id: 'acc1', agent_id: 'ag1', assigned_to: null, team_id: null, updated_at: 0 },
]
const EQUIPOS = [
  { id: 'team_ventas', member_ids: ['mem_ana'] },       // ya parseado, como lo devuelve mysql2
  { id: 'team_soporte', member_ids: ['mem_beto'] },
]
const MIEMBROS = [
  { id: 'mem_ana',  permissions: { inbox: true, soloAsignadas: true } },
  { id: 'mem_beto', permissions: { inbox: true, soloAsignadas: true } },
  { id: 'mem_jefe', permissions: { inbox: true, admins: true } },
]

const consultas = []
const pool = {
  async query(sql, params) {
    consultas.push(sql)
    if (/FROM conversations WHERE account_id=\? AND agent_id=\?/i.test(sql)) return [CONVS]
    if (/FROM conversations WHERE id=\? AND account_id=\? AND agent_id=\?/i.test(sql)) return [CONVS.filter(c => c.id === params[0])]
    if (/FROM conversations WHERE id=\? AND account_id=\?/i.test(sql)) return [CONVS.filter(c => c.id === params[0])]
    if (/FROM teams WHERE id=\? AND account_id=\?/i.test(sql)) return [EQUIPOS.filter(t => t.id === params[0])]
    if (/FROM teams WHERE account_id=\?/i.test(sql)) return [EQUIPOS]
    if (/FROM members m JOIN roles r/i.test(sql)) return [MIEMBROS]
    if (/FROM messages WHERE conversation_id IN/i.test(sql)) return [[]]
    if (/FROM messages WHERE conversation_id=\?/i.test(sql)) return [[]]
    return [[]]
  },
}

const dobles = {
  [path.join(raiz, 'db.js')]: pool,
  [path.join(raiz, 'services', 'socket.js')]: { emit() {}, emitToConv() {}, emitToMember() {} },
}
Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const visibilidad = require('../services/visibilidadConvos')
const ctrl = require('../controllers/conversations.controller')

const ANA  = { type: 'member', id: 'mem_ana',  accountId: 'acc1', permissions: { inbox: true, soloAsignadas: true } }
const JEFE = { type: 'member', id: 'mem_jefe', accountId: 'acc1', permissions: { inbox: true, admins: true } }

const respuesta = () => {
  const r = { code: 200, cuerpo: null }
  r.status = c => { r.code = c; return r }
  r.json = d => { r.cuerpo = d; return r }
  return r
}

;(async () => {
  console.log('\n· La LISTA: solo lo suyo y lo de su equipo')
  {
    visibilidad.olvidarCache()
    const res = respuesta()
    await ctrl.listConvos({ params: { accId: 'acc1', agId: 'ag1' }, user: ANA }, res)
    const ids = (res.cuerpo || []).map(c => c.id).sort()
    ok(ids.join(',') === 'c1,c2', `ve la suya y la de su equipo (${ids.join(', ') || 'ninguna'})`)
    ok(!ids.includes('c3'), 'no ve la de otro asesor')
    ok(!ids.includes('c4'), 'ni las que no tienen dueño')
  }

  console.log('\n· Contraste: sin el permiso se sigue viendo todo')
  {
    const res = respuesta()
    await ctrl.listConvos({ params: { accId: 'acc1', agId: 'ag1' }, user: JEFE }, res)
    ok((res.cuerpo || []).length === 4, `el jefe ve las cuatro (${(res.cuerpo || []).length})`)
  }
  {
    // El widget del webchat llega sin sesión: no se le puede cambiar el comportamiento.
    const res = respuesta()
    await ctrl.listConvos({ params: { accId: 'acc1', agId: 'ag1' }, user: null }, res)
    ok((res.cuerpo || []).length === 4, 'y una petición sin sesión tampoco cambia')
  }

  console.log('\n· El CHAT SUELTO')
  {
    const propia = respuesta()
    await ctrl.getConvo({ params: { accId: 'acc1', agId: 'ag1', convId: 'c1' }, user: ANA }, propia)
    ok(propia.code === 200 && propia.cuerpo?.id === 'c1', 'la suya se abre')

    const ajena = respuesta()
    await ctrl.getConvo({ params: { accId: 'acc1', agId: 'ag1', convId: 'c3' }, user: ANA }, ajena)
    ok(ajena.code === 404, `la ajena da 404 (fue ${ajena.code})`)
    ok(!/no tienes permiso|403/i.test(JSON.stringify(ajena.cuerpo)),
      'y no dice que exista: un 403 sería un oráculo de qué conversaciones hay')

    const delJefe = respuesta()
    await ctrl.getConvo({ params: { accId: 'acc1', agId: 'ag1', convId: 'c3' }, user: JEFE }, delJefe)
    ok(delJefe.code === 200, 'contraste: el jefe sí la abre')
  }

  console.log('\n· Las ESCRITURAS: el guard de las rutas')
  {
    // Se saca del archivo de rutas de verdad: una copia aquí se quedaría vieja y la prueba
    // pasaría mientras el servidor deja escribir.
    const fuente = fs.readFileSync(path.join(raiz, 'routes', 'conversations.routes.js'), 'utf8')
    ok(/router\.param\('convId', soloSiPuedeVer\)/.test(fuente),
      'el guard cuelga de router.param, que solo dispara donde :convId existe de verdad')
    ok(!/router\.use\('\/:accId\/:agId\/:convId'/.test(fuente),
      'y NO de un prefijo, que atraparía también /:accId/:agId/whatsapp')

    const lineas = fuente.split('\n')
    const i = lineas.findIndex(l => l.startsWith('async function soloSiPuedeVer'))
    const j = lineas.findIndex((l, k) => k > i && l === '}')
    const guard = eval(`(${lineas.slice(i, j + 1).join('\n').replace(/^async function soloSiPuedeVer/, 'async function')})`)

    const correr = (user, convId) => new Promise(res => {
      const r = respuesta()
      guard({ params: { accId: 'acc1', convId }, user }, r, () => res({ paso: true, r }), convId)
        .then(() => setTimeout(() => res({ paso: false, r }), 0))
    })

    const suya = await correr(ANA, 'c1')
    ok(suya.paso, 'puede escribir en la suya')
    const ajena = await correr(ANA, 'c3')
    ok(!ajena.paso && ajena.r.code === 404, `no puede escribir en la ajena (${ajena.r.code})`)
    const jefe = await correr(JEFE, 'c3')
    ok(jefe.paso, 'contraste: el jefe sí')
    const invitado = await correr(null, 'c3')
    ok(invitado.paso, 'y el invitado del webchat, sin sesión, pasa como siempre')
  }

  console.log('\n· El TIEMPO REAL: un restringido no entra en la sala de la cuenta')
  {
    // Se ejecuta el alta en salas EXTRAÍDA de index.js, igual que handshake-socket.test.js:
    // una copia aquí se quedaría vieja mientras el servidor reparte de más.
    const lineas = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8').split('\n')
    const i = lineas.findIndex(l => l.startsWith('  const u = sock.user'))
    const j = lineas.findIndex((l, k) => k > i && l === '  }')
    const entrarEnSalas = eval(`(sock => {\n${lineas.slice(i, j + 1).join('\n')}\n})`)

    const salasDe = user => {
      const salas = []
      entrarEnSalas({ user, join: s => salas.push(s) })
      return salas
    }

    const deAna = salasDe({ ...ANA, allAccountIds: ['acc1'] })
    ok(!deAna.includes('acc:acc1'), `Ana NO entra en acc:acc1 (${deAna.join(', ')})`)
    ok(deAna.includes('mem:mem_ana'), 'pero sí en su sala personal, por donde se le reparte')

    const deJefe = salasDe({ ...JEFE, allAccountIds: ['acc1'] })
    ok(deJefe.includes('acc:acc1'), 'contraste: el jefe sí entra en la sala de la cuenta')
  }

  console.log('\n· …y se le reparte solo lo de SUS conversaciones')
  {
    visibilidad.olvidarCache()
    const suya = await visibilidad.destinatariosRestringidos('acc1', 'c1')
    ok(suya.join() === 'mem_ana', `de la suya, a Ana (${suya.join(', ') || 'nadie'})`)

    const deEquipo = await visibilidad.destinatariosRestringidos('acc1', 'c2')
    ok(deEquipo.includes('mem_ana') && !deEquipo.includes('mem_beto'),
      `de la de su equipo, a Ana y no a Beto (${deEquipo.join(', ')})`)

    const ajena = await visibilidad.destinatariosRestringidos('acc1', 'c3')
    ok(!ajena.includes('mem_ana'), 'de la ajena, a Ana no le llega')

    const sinDuenno = await visibilidad.destinatariosRestringidos('acc1', 'c4')
    ok(sinDuenno.length === 0, 'y la que no tiene dueño no se reparte a ningún restringido')
  }

  console.log('\n· La caché no consulta cuando no hace falta, y se puede olvidar')
  {
    visibilidad.olvidarCache()
    await visibilidad.miembrosRestringidos('acc1')
    const antes = consultas.filter(s => /FROM members m JOIN roles r/i.test(s)).length
    await visibilidad.miembrosRestringidos('acc1')
    const despues = consultas.filter(s => /FROM members m JOIN roles r/i.test(s)).length
    ok(antes === despues, 'la segunda vez sale de la caché')
    visibilidad.olvidarCache('acc1')
    await visibilidad.miembrosRestringidos('acc1')
    ok(consultas.filter(s => /FROM members m JOIN roles r/i.test(s)).length === despues + 1,
      'y tras olvidarla vuelve a consultar — si no, cambiar el permiso tardaría en notarse')
  }

  console.log('\n· Los equipos se leen sin pasar arrays como parámetro')
  {
    const equipos = await visibilidad.equiposDe('acc1', 'mem_ana')
    ok(equipos.join() === 'team_ventas', `Ana está en ventas (${equipos.join(', ')})`)
    const sql = consultas.filter(s => /FROM teams/i.test(s)).pop()
    ok(!/JSON_CONTAINS/i.test(sql), 'sin JSON_CONTAINS: mysql2 expande los arrays y revienta la consulta')
  }

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
