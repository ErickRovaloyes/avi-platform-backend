'use strict'
/**
 * Lo que el Agente de Cambios estima que va a ocupar su respuesta.
 *
 *   node pruebas/estimado-agente-cambios.test.js
 *
 * El caso real: «⚠ La respuesta se cortó por tamaño (tope de 6821 tokens con deepseek-v4-flash)».
 * 6 821 no era ningún techo del modelo —deepseek-v4-flash devuelve hasta 384 000— sino el propio
 * estimado: 6821 ÷ 1,25 = 5 457, que es exactamente `prompt_actual × 1,1` para un prompt de unos
 * 4 960 tokens. Es decir, no se recortó nada: se pidió lo que esta función dijo, y esta función
 * dijo de menos.
 *
 * El motivo: el agente devuelve el prompt ENTERO reescrito, así que la salida es «lo que ya hay
 * MÁS lo que se añade». Solo se miraba lo que ya hay. En cuanto alguien adjunta un documento y
 * pide incorporarlo, el prompt crece por el tamaño del documento y el factor de la categoría se
 * queda muy corto.
 */
const { estimateOutputTokens } = require('../controllers/promptGenerator.controller')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

;(async () => {
  console.log('\n· El caso que falló, con sus números')
  {
    // El prompt del usuario, reconstruido desde el mensaje de error.
    const PROMPT = 4961
    ok(Math.round(PROMPT * 1.1 * 1.25) === 6821,
      'la cuenta vieja da exactamente los 6 821 del aviso — es el estimado, no un techo')

    // El mismo cambio, pero contando que se estaba incorporando material nuevo.
    const DOCUMENTO = 8000
    const conAñadido = estimateOutputTokens('basic', PROMPT, DOCUMENTO)
    ok(conAñadido > 6821 * 1.5, `ahora se estima de sobra para el resultado (${conAñadido})`)
    ok(conAñadido === Math.round((PROMPT + DOCUMENTO) * 1.1),
      'porque la salida es lo que ya había MÁS lo que se añade')
  }

  console.log('\n· Contraste: un cambio que no añade nada no infla el estimado')
  {
    // «Cambia el tono a más formal» no trae material: el estimado tiene que ser el de antes.
    const PROMPT = 4961
    const instruccionCorta = 12
    const antes = Math.max(200, Math.round(PROMPT * 1.1))
    ok(estimateOutputTokens('basic', PROMPT, instruccionCorta) - antes < 20,
      'una instrucción de una línea apenas mueve la cifra')
    ok(estimateOutputTokens('basic', PROMPT, 0) === antes,
      'y sin añadido es exactamente lo de siempre — el cambio no encarece lo que ya funcionaba')
  }

  console.log('\n· Las tres categorías siguen ordenadas')
  {
    const P = 3000, A = 1000
    const b = estimateOutputTokens('basic', P, A)
    const m = estimateOutputTokens('medium', P, A)
    const c = estimateOutputTokens('complex', P, A)
    ok(b < m && m < c, `basic < medium < complex (${b} < ${m} < ${c})`)
    ok(c === Math.round((P + A) * 1.6), 'y un replanteo entero sigue siendo el que más margen pide')
  }

  console.log('\n· Tolerancia')
  {
    ok(estimateOutputTokens('basic', 0, 0) === 200, 'sin nada, el suelo de la categoría')
    ok(estimateOutputTokens('medium', 1000) === 1300, 'y funciona sin pasarle el añadido')
    ok(estimateOutputTokens('basic', 1000, -5000) === 1100,
      'un añadido negativo no descuenta (sería pedir de menos por un error de cuenta)')
  }

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
