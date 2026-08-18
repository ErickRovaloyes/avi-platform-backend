'use strict'
/**
 * El handshake del socket: quién entra, a qué salas, y qué pasa con un token que no verifica.
 *
 *   node pruebas/handshake-socket.test.js
 *
 * Aquí se deciden las salas de un socket, y es un sitio donde equivocarse no da ningún error:
 * el socket queda «conectado» igual, simplemente no recibe nada. La bandeja se ve normal y muda.
 *
 * Se ejecuta el código REAL extraído de index.js, no una copia: una copia se queda
 * desactualizada y entonces la prueba pasa mientras el servidor falla.
 */
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')
const { sign } = require('../auth')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

// ── Se saca del index.js de verdad ────────────────────────────────────────────
// Por líneas y no por el primer `})`: el middleware contiene uno dentro
// (`leerToken({ … })`), y cortar ahí daba un trozo de código sin sentido.

const lineas = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').split('\n')

/** Del renglón que empieza por `desde` hasta el primero que sea exactamente `cierre`. */
function bloque(desde, cierre) {
  const i = lineas.findIndex(l => l.startsWith(desde))
  if (i < 0) throw new Error(`no encuentro el inicio: ${desde}`)
  const j = lineas.findIndex((l, k) => k > i && l === cierre)
  if (j < 0) throw new Error(`no encuentro el cierre de: ${desde}`)
  return lineas.slice(i, j + 1).join('\n')
}

const { verify, tokenDe: leerToken } = require('../auth')

// El middleware de autenticación, tal cual está escrito.
const codigoAuth = bloque('io.use((sock, next) => {', '})')
  .replace(/^io\.use\(/, '').replace(/\)$/, '')
const autenticar = eval(`(${codigoAuth})`)

// Y el trozo de io.on('connection') que entra en las salas.
const codigoSalas = bloque('  const u = sock.user', '  }')
const entrarEnSalas = eval(`(sock => {\n${codigoSalas}\n})`)

// ── Dobles mínimos ────────────────────────────────────────────────────────────

const galleta = t => `avi_jwt=${encodeURIComponent(t)}`

function socketFalso(cookie) {
  const salas = []
  return {
    salas,
    join: s => salas.push(s),
    handshake: { headers: cookie ? { cookie } : {}, auth: {} },
  }
}
const correr = sock => new Promise(res => autenticar(sock, err => res(err || null)))

;(async () => {
  console.log('\n· Una sesion valida entra en las salas de SUS cuentas')
  {
    const s = socketFalso(galleta(sign({ type: 'member', id: 'u1', accountId: 'acc_1', allAccountIds: ['acc_1', 'acc_2'] })))
    ok(!(await correr(s)), 'el handshake se acepta')
    entrarEnSalas(s)
    ok(s.salas.includes('acc:acc_1') && s.salas.includes('acc:acc_2'), `entra en sus dos cuentas (${s.salas.join(', ')})`)
    ok(s.salas.includes('mem:u1'), 'y en su sala personal')
  }

  console.log('\n· Un super admin NO esta en ninguna sala de cuenta')
  {
    // Esto es lo que hacia que entrar en una cuenta desde el superpanel dejara el inbox mudo:
    // el socket se abria asi y luego NO se rehacia el handshake al cambiar de identidad.
    const s = socketFalso(galleta(sign({ type: 'superadmin', id: 'sa_1', email: 'sa@x.com' })))
    ok(!(await correr(s)), 'su handshake es valido')
    entrarEnSalas(s)
    ok(s.salas.filter(x => x.startsWith('acc:')).length === 0,
      'no entra en ninguna acc: — por eso el socket TIENE que reabrirse al entrar en una cuenta')
  }

  console.log('\n· Un token que no verifica se rechaza, no se acepta sordo')
  {
    // Firmado con otro secreto: es el mismo camino que un token caducado o revocado.
    const ajeno = jwt.sign({ type: 'member', id: 'u1', accountId: 'acc_1' }, 'otro-secreto-distinto')
    const s = socketFalso(galleta(ajeno))
    const err = await correr(s)
    ok(!!err, 'el handshake se rechaza')
    ok(String(err?.message) === 'sesion_invalida', `con un motivo claro (${err?.message})`)
    ok(s.salas.length === 0, 'y no llega a entrar en ninguna sala')

    // Contraste: como estaba antes se aceptaba, y quedaba un socket conectado y sordo — que
    // desde la pantalla es indistinguible de uno sano.
    const comoAntes = socketFalso(galleta(ajeno))
    comoAntes.user = verify(leerToken({ headers: comoAntes.handshake.headers }))
    entrarEnSalas(comoAntes)
    ok(comoAntes.user === null && comoAntes.salas.length === 0,
      'contraste: aceptarlo daba un socket «conectado» sin una sola sala')
  }

  console.log('\n· El invitado del webchat sigue entrando')
  {
    const s = socketFalso(null)   // sin cookie y sin auth.token
    ok(!(await correr(s)), 'sin token el handshake se acepta (lo necesita para unirse a su conv:)')
    entrarEnSalas(s)
    ok(s.salas.length === 0, 'y no entra en ninguna sala privada')
  }

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
