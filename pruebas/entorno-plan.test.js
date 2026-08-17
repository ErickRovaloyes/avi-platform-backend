'use strict'
/**
 * El entorno de pruebas comparte plan Y consumo con su cuenta real.
 *
 *   node pruebas/entorno-plan.test.js
 *
 * Si el entorno se quedara en el plan gratuito no serviría para nada: las funciones que se
 * quieren ensayar son justo las que da el plan de pago. Y el consumo va al mismo sitio, porque
 * el entorno no tiene fila propia en `account_subscriptions`: sin resolver la cuenta de
 * facturación, las conversaciones de prueba no se contarían en ninguna parte.
 */
const path = require('path')
const Module = require('module')

const CUENTAS = {
  acc_real: { id: 'acc_real', sandbox_of: null },
  acc_test: { id: 'acc_test', sandbox_of: 'acc_real' },   // el entorno
  acc_sola: { id: 'acc_sola', sandbox_of: null },         // una cuenta sin suscripción
}
// Solo la cuenta REAL tiene fila de suscripción.
const SUSCRIPCIONES = {
  acc_real: {
    id: 'sub1', account_id: 'acc_real', account_type_id: 'tipo1', subscription_plan_id: 'plan_pro',
    conversation_count_current_period: 40, contact_count_current_period: 7,
    current_period_start: 1, current_period_end: 9e15, status: 'active',
  },
}
const escrituras = []

const raiz = path.resolve(__dirname, '..')
const dobles = {
  [path.join(raiz, 'db.js')]: {
    async query(sql, params = []) {
      if (/^\s*UPDATE account_subscriptions/i.test(sql)) {
        const accId = params[params.length - 1]
        escrituras.push(accId)
        return [{ affectedRows: SUSCRIPCIONES[accId] ? 1 : 0 }]
      }
      // Un contacto nuevo en el ciclo (INSERT IGNORE que sí inserta) dispara el recuento.
      if (/^\s*INSERT IGNORE INTO subscription_(contact|ai_contact)_activity/i.test(sql)) {
        escrituras.push(params[0])
        return [{ affectedRows: 1 }]
      }
      if (/COUNT\(\*\) AS n FROM subscription_/i.test(sql)) return [[{ n: 8 }]]
      if (/AS x FROM subscription_ai_contact_activity/i.test(sql)) return [[]]   // aún no visto
      if (/sandbox_of FROM accounts/i.test(sql)) return [[CUENTAS[params[0]]].filter(Boolean)]
      if (/FROM account_subscriptions/i.test(sql)) return [[SUSCRIPCIONES[params[0]]].filter(Boolean)]
      if (/FROM account_types/i.test(sql))  return [[{ id: 'tipo1', name: 'Empresa', modules: null }]]
      if (/FROM subscription_plans/i.test(sql)) return [[{ id: 'plan_pro', name: 'Pro', family: 'crm', monthly_limit: 500 }]]
      return [[]]
    },
  },
}
const cargarOriginal = Module._load
Module._load = function (pedido, padre, esPrincipal) {
  const resuelto = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (resuelto && dobles[resuelto]) return dobles[resuelto]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const subs = require('../services/subscriptions')

let fallos = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos++ }

;(async () => {
  console.log('\n· El entorno lee el plan de su cuenta real')
  const real = await subs.getSubscription('acc_real')
  const test = await subs.getSubscription('acc_test')
  ok(!!real, 'la cuenta real tiene suscripción')
  ok(!!test, 'y el entorno TAMBIÉN devuelve una (no se queda sin plan)')
  ok(test.subscriptionPlanId === real.subscriptionPlanId,
    `mismo plan (${test?.subscriptionPlanId})`)
  ok(test.accountTypeId === real.accountTypeId, 'mismo tipo de cuenta')
  ok(test.conversationCount === real.conversationCount, 'y ve el mismo consumo del ciclo')

  console.log('\n· Contraste: una cuenta normal sin suscripción sigue sin ella')
  ok((await subs.getSubscription('acc_sola')) === null,
    'acc_sola devuelve null — la herencia no inventa planes')

  console.log('\n· Y el consumo de las pruebas cuenta como consumo REAL')
  escrituras.length = 0
  await subs.incrementConversation('acc_test')
  ok(escrituras.length === 1 && escrituras[0] === 'acc_real',
    `una conversación en el entorno suma a la cuenta real (escribió en ${escrituras[0]})`)
  ok(!escrituras.includes('acc_test'),
    'y NO al entorno, que no tiene fila: ahí no se contaría en ninguna parte')

  escrituras.length = 0
  await subs.markContactActive('acc_test', 'contacto1')
  ok(escrituras.includes('acc_real'), 'los contactos del entorno también cuentan en la cuenta real')

  escrituras.length = 0
  await subs.claimAiContact('acc_test', 'contacto2', 100)
  ok(escrituras.includes('acc_real'), 'y los contactos con IA igual')

  // Y por el otro lado: una cuenta normal sigue sumando a la suya.
  escrituras.length = 0
  await subs.incrementConversation('acc_real')
  ok(escrituras[0] === 'acc_real', 'una cuenta normal suma a la suya, como siempre')

  console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${fallos} comprobación(es) fallida(s)\n`)
  process.exit(fallos ? 1 : 0)
})()
