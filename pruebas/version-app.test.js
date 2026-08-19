'use strict'
/**
 * El endpoint que dice qué versión de la app móvil hay publicada.
 *
 *   node pruebas/version-app.test.js
 *
 * Dos cosas que comprobar, y la segunda es la que importa:
 *
 *   1. Que devuelva lo guardado, y que un fallo NO deje a nadie fuera de la app.
 *   2. Que no filtre nada más. `platform_settings` guarda en la MISMA fila los secretos de Meta,
 *      Google y Octorate, y este endpoint no lleva autenticación: seleccionar de más aquí es
 *      publicarlos en internet.
 */
const path = require('path')
const Module = require('module')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

const raiz = path.resolve(__dirname, '..')
const cargarOriginal = Module._load

let fila = {}
let ultimoSql = ''
let romper = false

const dobles = {
  [path.join(raiz, 'db.js')]: {
    query: async (sql) => {
      ultimoSql = String(sql)
      if (romper) throw new Error('base caída')
      return [[fila]]
    },
  },
  [path.join(raiz, 'services', 'socket.js')]: { emit() {}, emitToConv() {}, emitToMember() {} },
}
Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const ctrl = require('../controllers/platform.controller')

const respuesta = () => {
  const r = { code: 200, cuerpo: null }
  r.status = c => { r.code = c; return r }
  r.json = d => { r.cuerpo = d; return r }
  return r
}
const pedir = async (user = null) => {
  const res = respuesta()
  await ctrl.getAppVersion({ user, params: {}, query: {} }, res)
  return res
}

;(async () => {
  console.log('\n· Devuelve lo que hay publicado')
  {
    fila = { app_version: '1.2.0', app_apk_url: 'https://expo.dev/artifacts/eas/abc', app_notas: 'Vídeo dentro de la app', app_obligatoria: 1 }
    const r = await pedir()
    ok(r.cuerpo?.version === '1.2.0', `la versión (${r.cuerpo?.version})`)
    ok(r.cuerpo?.apkUrl.includes('expo.dev'), 'la URL de descarga')
    ok(r.cuerpo?.notas === 'Vídeo dentro de la app', 'y qué cambia')
    ok(r.cuerpo?.obligatoria === true, 'con el aviso marcado como obligatorio')
  }

  console.log('\n· Sin sesión, que es como la llama la app antes de entrar')
  {
    const r = await pedir(null)
    ok(r.code === 200, `responde 200 sin usuario (fue ${r.code})`)
  }

  console.log('\n· No publica NADA más de platform_settings')
  {
    // La fila trae los secretos de las integraciones: si la consulta pidiera de más, saldrían.
    fila = {
      app_version: '1.2.0', app_apk_url: 'u', app_notas: '', app_obligatoria: 0,
      meta_app_secret: 'SECRETO-META', google_client_secret: 'SECRETO-GOOGLE',
      octorate_client_secret: 'SECRETO-OCTORATE', openai_key: 'sk-SECRETO',
    }
    const r = await pedir()
    const texto = JSON.stringify(r.cuerpo)
    ok(!/SECRETO/.test(texto), `la respuesta no lleva ningún secreto (${texto.slice(0, 70)}…)`)
    ok(Object.keys(r.cuerpo).sort().join(',') === 'apkUrl,notas,obligatoria,version',
      `y devuelve exactamente cuatro campos (${Object.keys(r.cuerpo).join(', ')})`)
    // El SELECT tampoco los pide: aunque alguien añadiera un campo al json, no habría de dónde.
    ok(!/SELECT \*/i.test(ultimoSql), 'la consulta nombra las columnas, no usa SELECT *')
    ok(!/secret/i.test(ultimoSql), `y no pide ninguna columna de secretos`)
  }

  console.log('\n· Un fallo no deja a nadie fuera de la app')
  {
    romper = true
    const r = await pedir()
    romper = false
    ok(r.code === 200, `responde 200 aunque la base falle (fue ${r.code})`)
    ok(r.cuerpo?.version === '' && r.cuerpo?.obligatoria === false,
      'diciendo «no hay nada publicado», que es lo que deja entrar')
  }

  console.log('\n· El aviso puede no ser obligatorio')
  {
    fila = { app_version: '1.2.0', app_apk_url: 'u', app_notas: '', app_obligatoria: 0 }
    ok((await pedir()).cuerpo?.obligatoria === false, 'si se desmarca, no bloquea')
    fila = { app_version: '1.2.0', app_apk_url: 'u', app_notas: '' }
    ok((await pedir()).cuerpo?.obligatoria === true, 'y sin valor guardado, sí (es lo prudente)')
  }

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
