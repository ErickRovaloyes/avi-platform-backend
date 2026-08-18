'use strict'
/**
 * Catálogo de herramientas IA: instalar, actualizar y quién puede hacerlo.
 *
 *   node pruebas/catalogo-herramientas.test.js
 *
 * Lo importante aquí es el AISLAMIENTO: instalar en una cuenta no puede tocar otra, y publicar
 * en el catálogo tiene que ser cosa del super admin. Lo segundo es la clase de fallo que ya
 * apareció una vez en gestión de equipo —una cuenta operando sobre otra—, así que se comprueba
 * ejecutando, no leyendo.
 */
const path = require('path')
const Module = require('module')

// ── Base de datos de mentira, con estado ──────────────────────────────────────
const catalogo = [
  { id: 'cat_1', name: 'Cotizador de seguros', summary: 'Calcula primas', description: 'Pide datos y cotiza.',
    icon: 'calculadora', category: 'Ventas', collect_fields: '[{"id":"edad"}]', action_type: 'variable',
    flow_template: null, version: 2, published: 1, created_at: 1, updated_at: 1 },
  { id: 'cat_2', name: 'Borrador sin publicar', summary: '', description: '', icon: 'herramienta',
    category: 'General', collect_fields: '[]', action_type: 'variable', flow_template: null,
    version: 1, published: 0, created_at: 1, updated_at: 1 },
]
let aiTools = []   // [{ id, account_id, catalog_id, catalog_version, name, ... }]

const pool = {
  async query(sql, params = []) {
    if (/FROM tool_catalog WHERE id=\? AND published=1/i.test(sql)) {
      return [catalogo.filter(c => c.id === params[0] && c.published)]
    }
    if (/FROM tool_catalog WHERE published=1/i.test(sql) || /FROM tool_catalog\s+ORDER/i.test(sql)) {
      return [/published=1/.test(sql) ? catalogo.filter(c => c.published) : catalogo]
    }
    if (/SELECT catalog_id, catalog_version FROM ai_tools/i.test(sql)) {
      return [aiTools.filter(t => t.account_id === params[0] && t.catalog_id)]
    }
    if (/SELECT id FROM ai_tools WHERE account_id=\? AND catalog_id=\?/i.test(sql)) {
      return [aiTools.filter(t => t.account_id === params[0] && t.catalog_id === params[1])]
    }
    if (sql.trim().toUpperCase().startsWith('INSERT INTO AI_TOOLS')) {
      // Las columnas se leen del propio SQL: mapearlas por POSICION se rompe cada vez que se
      // anade una (handler_key, parameters) y la prueba falla por el doble, no por el codigo.
      const abre = sql.indexOf('(')
      const cierra = sql.indexOf(')', abre)
      const cols = sql.slice(abre + 1, cierra).split(',').map(x => x.trim())
      const fila = {}
      cols.forEach((c, i) => { fila[c] = params[i] })
      aiTools.push(fila)
      return [{ affectedRows: 1 }]
    }
    if (sql.trim().toUpperCase().startsWith('UPDATE AI_TOOLS SET NAME=')) {
      const cols = sql.slice(sql.toUpperCase().indexOf('SET') + 3, sql.toUpperCase().indexOf('WHERE'))
        .split(',').map(x => x.split('=')[0].trim())
      const t = aiTools.find(x => x.id === params[params.length - 1])
      if (t) cols.forEach((c, i) => { t[c] = params[i] })
      return [{ affectedRows: 1 }]
    }
    if (/^\s*DELETE FROM ai_tools WHERE account_id=\? AND catalog_id=\?/i.test(sql)) {
      const antes = aiTools.length
      aiTools = aiTools.filter(t => !(t.account_id === params[0] && t.catalog_id === params[1]))
      return [{ affectedRows: antes - aiTools.length }]
    }
    return [[]]
  },
}

const raiz = path.resolve(__dirname, '..')
const dobles = {
  [path.join(raiz, 'db.js')]: pool,
  [path.join(raiz, 'services', 'socket.js')]: { emit() {}, emitToConv() {}, emitToMember() {}, broadcast() {} },
}
const cargarOriginal = Module._load
Module._load = function (pedido, padre, esPrincipal) {
  const resuelto = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (resuelto && dobles[resuelto]) return dobles[resuelto]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const ctrl = require('../controllers/toolCatalog.controller')

let fallos = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos++ }
const resFalsa = () => {
  const r = { code: 200, cuerpo: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.cuerpo = b; return r }
  return r
}
const DUENO_1 = { type: 'member', accountId: 'acc1', roleId: 'role_owner_x', id: 'm1' }
const DUENO_2 = { type: 'member', accountId: 'acc2', roleId: 'role_owner_y', id: 'm2' }
const SUPER   = { type: 'superadmin', id: 's1' }

;(async () => {
  console.log('\n· Lo que ve una cuenta')
  let res = resFalsa()
  await ctrl.listCatalog({ params: { accId: 'acc1' }, user: DUENO_1 }, res)
  ok(res.cuerpo.length === 1, `solo lo publicado (fueron ${res.cuerpo.length} de 2)`)
  ok(!res.cuerpo.some(t => t.id === 'cat_2'), 'el borrador no se enseña')
  ok(res.cuerpo[0].installed === false, 'y aún no está instalada')

  console.log('\n· El super admin ve también los borradores')
  res = resFalsa()
  await ctrl.listCatalog({ params: {}, user: SUPER }, res)
  ok(res.cuerpo.length === 2, `ve las 2 (fueron ${res.cuerpo.length})`)

  console.log('\n· Instalar')
  res = resFalsa()
  await ctrl.installTool({ params: { accId: 'acc1', toolId: 'cat_1' }, user: DUENO_1 }, res)
  ok(res.code === 200 && res.cuerpo.installed, `se instala (${res.code})`)
  ok(aiTools.length === 1 && aiTools[0].account_id === 'acc1', 'queda en las herramientas de acc1')
  ok(aiTools[0].catalog_id === 'cat_1' && aiTools[0].catalog_version === 2, 'con su origen y versión')

  res = resFalsa()
  await ctrl.listCatalog({ params: { accId: 'acc1' }, user: DUENO_1 }, res)
  ok(res.cuerpo[0].installed === true, 'y el catálogo ya la marca como instalada')
  ok(res.cuerpo[0].updateAvailable === false, 'sin actualización pendiente (misma versión)')

  console.log('\n· Aislamiento entre cuentas')
  res = resFalsa()
  await ctrl.listCatalog({ params: { accId: 'acc2' }, user: DUENO_2 }, res)
  ok(res.cuerpo[0].installed === false, 'acc2 NO la ve instalada — la instaló acc1')

  res = resFalsa()
  await ctrl.installTool({ params: { accId: 'acc1', toolId: 'cat_1' }, user: DUENO_2 }, res)
  ok(res.code === 403, `el dueño de acc2 no puede instalar en acc1 (fue ${res.code})`)
  ok(aiTools.length === 1, 'y no se creó nada')

  console.log('\n· Actualización cuando el catálogo avanza')
  catalogo[0].version = 3
  res = resFalsa()
  await ctrl.listCatalog({ params: { accId: 'acc1' }, user: DUENO_1 }, res)
  ok(res.cuerpo[0].updateAvailable === true, 'se ofrece la actualización (v3 sobre v2 instalada)')
  res = resFalsa()
  await ctrl.installTool({ params: { accId: 'acc1', toolId: 'cat_1' }, user: DUENO_1 }, res)
  ok(res.cuerpo.updated === true, 'actualiza en vez de duplicar')
  ok(aiTools.length === 1, `sigue habiendo UNA (hay ${aiTools.length})`)
  ok(aiTools[0].catalog_version === 3, 'ya en la versión 3')

  console.log('\n· Publicar es cosa del super admin')
  res = resFalsa()
  await ctrl.upsertCatalogTool({ params: {}, body: { name: 'Cuela' }, user: DUENO_1 }, res)
  ok(res.code === 403, `un dueño de cuenta no publica (fue ${res.code})`)
  res = resFalsa()
  await ctrl.deleteCatalogTool({ params: { toolId: 'cat_1' }, user: DUENO_1 }, res)
  ok(res.code === 403, `ni borra del catálogo (fue ${res.code})`)

  console.log('\n· Desinstalar')
  res = resFalsa()
  await ctrl.uninstallTool({ params: { accId: 'acc1', toolId: 'cat_1' }, user: DUENO_1 }, res)
  ok(res.code === 200 && aiTools.length === 0, 'se quita de la cuenta')

  console.log('\n· Contraste: lo no publicado no se puede instalar')
  res = resFalsa()
  await ctrl.installTool({ params: { accId: 'acc1', toolId: 'cat_2' }, user: DUENO_1 }, res)
  ok(res.code === 404, `el borrador no se instala (fue ${res.code})`)

  console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${fallos} comprobación(es) fallida(s)\n`)
  process.exit(fallos ? 1 : 0)
})()
