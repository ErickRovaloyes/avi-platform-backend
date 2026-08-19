'use strict'
/**
 * Por qué no conecta una tienda WooCommerce.
 *
 *   node pruebas/woo-diagnostico.test.js
 *
 * Nace de un caso real: conectar niido.co daba `UND_ERR_CONNECT_TIMEOUT` y el mensaje decía
 * «Revisa que la URL sea correcta y que la tienda esté en línea». La URL era correcta y la
 * tienda respondía 200 desde fuera; lo que fallaba era que su hosting descartaba los paquetes
 * de ESE servidor. El mensaje mandó a mirar donde no era, y eso cuesta tiempo de verdad.
 *
 * Aquí se fija que cada fallo de red diga lo suyo, porque todos «parecen» el mismo error.
 */
const path = require('path')
const Module = require('module')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

const raiz = path.resolve(__dirname, '..')
const cargarOriginal = Module._load
const dobles = {
  [path.join(raiz, 'db.js')]: { query: async () => [[]] },
  [path.join(raiz, 'services', 'socket.js')]: { emit() {}, emitToConv() {}, emitToMember() {} },
}
Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const woo = require('../services/woocommerce')

const CFG = { storeUrl: 'https://niido.co', consumerKey: 'ck_x', consumerSecret: 'cs_x' }

/** Un fallo de red como los que produce undici: el código va dentro de `cause`. */
const falloDeRed = codigo => Object.assign(new Error('fetch failed'), { cause: { code: codigo } })

const fetchReal = global.fetch
const conFetch = async (impl, fn) => { global.fetch = impl; try { return await fn() } finally { global.fetch = fetchReal } }

;(async () => {
  console.log('\n· Cada fallo de red dice lo suyo')

  const mensajeDe = async codigo => {
    const r = await conFetch(async () => { throw falloDeRed(codigo) }, () => woo.testConnection(CFG))
    return r.error || ''
  }

  {
    const m = await mensajeDe('UND_ERR_CONNECT_TIMEOUT')
    ok(/no acepta la conexión desde aquí/i.test(m), 'tiempo de espera al conectar → «no nos deja llegar»')
    ok(/bloquea a este servidor/i.test(m), 'y apunta al bloqueo del hosting, que es donde está el problema')
    ok(/NO es la URL ni las llaves/i.test(m), 'dice explícitamente dónde NO hay que mirar')
    // EL contraste que da sentido a todo esto.
    ok(!/Revisa que la URL sea correcta/i.test(m),
      'y ya NO repite «revisa que la URL sea correcta», que es lo que hizo perder el rato')
  }

  {
    const m = await mensajeDe('ENOTFOUND')
    ok(/no existe o no se pudo resolver/i.test(m), 'dominio que no resuelve → la URL sí está mal')
    ok(/URL esté bien escrita/i.test(m), 'y ahí sí se manda a revisarla')
  }

  {
    const m = await mensajeDe('ECONNREFUSED')
    ok(/rechazó la conexión/i.test(m), 'conexión rechazada → hay servidor, nada escuchando')
    ok(!/bloquea a este servidor/i.test(m), 'y no se confunde con un bloqueo: rechazar no es ignorar')
  }

  {
    const m = await mensajeDe('CERT_HAS_EXPIRED')
    ok(/certificado HTTPS/i.test(m) && /caducado/i.test(m), 'certificado caducado se nombra tal cual')
  }

  {
    const r = await conFetch(
      async () => { throw Object.assign(new Error('abort'), { name: 'TimeoutError' }) },
      () => woo.testConnection(CFG))
    ok(/no respondió en 20 s/.test(r.error), 'conectó pero tardó demasiado → es otro problema')
    ok(/hosting saturado/i.test(r.error), 'y se dice qué suele ser')
  }

  {
    const m = await mensajeDe('ALGO_RARO')
    ok(/ALGO_RARO/.test(m), 'un código desconocido se muestra tal cual, sin inventar diagnóstico')
  }

  console.log('\n· El diagnóstico solo se ejecuta cuando falló la RED')
  {
    // La tienda contestó 401: el problema ya está dicho, sondear DNS y sockets solo tardaría.
    let llamadas = 0
    const r = await conFetch(async () => {
      llamadas++
      return { ok: false, status: 401, text: async () => JSON.stringify({ message: 'clave inválida' }) }
    }, () => woo.testConnection(CFG))
    ok(r.ok === false && /clave inválida/.test(r.error), 'un 401 se reporta como lo que es')
    ok(!r.diagnostico, 'y NO se lanza el diagnóstico')
    ok(llamadas === 1, `ni se hacen llamadas de más (${llamadas})`)
  }

  {
    // Una tienda que va bien no puede notar nada de todo esto.
    let llamadas = 0
    const r = await conFetch(async () => {
      llamadas++
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 1, name: 'Producto' }]) }
    }, () => woo.testConnection(CFG))
    ok(r.ok === true && r.sample === 1, 'una tienda que responde sigue dando ok')
    ok(!r.diagnostico, 'sin diagnóstico')
    ok(llamadas === 1, `y con UNA sola llamada, como antes (${llamadas})`)
  }

  console.log('\n· Y cuando falló la red, el diagnóstico viene con datos')
  {
    const r = await conFetch(async (url) => {
      // La API de la tienda no conecta; el eco de la IP sí.
      if (String(url).includes('ipify')) return { ok: true, json: async () => ({ ip: '76.13.98.164' }) }
      throw falloDeRed('UND_ERR_CONNECT_TIMEOUT')
    }, () => woo.testConnection(CFG))

    ok(!!r.diagnostico, 'se adjunta el diagnóstico')
    ok(r.diagnostico?.host === 'niido.co', `con el dominio (${r.diagnostico?.host})`)
    ok(Array.isArray(r.diagnostico?.dns?.v4), 'la resolución DNS vista desde el servidor')
    ok(typeof r.diagnostico?.tcp?.abierta === 'boolean', 'si la conexión TCP llega a abrirse')
    ok(typeof r.diagnostico?.tcp?.ms === 'number', 'y cuánto tarda — es lo que separa bloqueo de lentitud')
    ok(r.diagnostico?.salida?.ip === '76.13.98.164', `la IP de salida para la lista blanca (${r.diagnostico?.salida?.ip})`)
    ok(r.diagnostico?.salida?.seguro === true, 'marcada como segura porque la confirmó el eco')
  }

  {
    // Sin eco, la IP se supone y se dice que es una suposición: dar una IP equivocada para
    // desbloquear es peor que no dar ninguna.
    const r = await conFetch(async (url) => {
      if (String(url).includes('ipify')) throw new Error('sin eco')
      throw falloDeRed('UND_ERR_CONNECT_TIMEOUT')
    }, () => woo.testConnection(CFG))
    ok(r.diagnostico?.salida?.seguro === false, 'sin eco, la IP queda marcada como suposición')
  }

  {
    const r = await conFetch(async () => { throw falloDeRed('UND_ERR_CONNECT_TIMEOUT') },
      () => woo.testConnection({ ...CFG, storeUrl: 'esto no es una url' }))
    ok(r.diagnostico?.urlInvalida === true, 'una URL que ni se puede analizar se dice, no se sondea')
  }

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
