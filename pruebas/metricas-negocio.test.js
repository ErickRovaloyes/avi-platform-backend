'use strict'
/**
 * Las métricas de negocio, contadas contra datos sembrados a mano.
 *
 *   node pruebas/metricas-negocio.test.js
 *
 * Lo que se comprueba es que cada número CUADRE con lo que se sembró, no que el endpoint
 * responda. Y en particular que los tiempos de respuesta de la IA y de las personas salgan
 * DISTINTOS: antes era un solo promedio que mezclaba los dos, y ese número no describe a
 * ninguno —la IA contesta en segundos y un asesor puede tardar horas—.
 */
const path = require('path')
const Module = require('module')

const T0 = 1_700_000_000_000        // instante base del periodo sembrado
const min = n => n * 60_000

// 4 conversaciones: 2 con tarjeta de pipeline, 2 con intención alta/media, 1 en seguimiento.
const conversaciones = [
  { id: 'c1', account_id: 'acc1', agent_id: 'ag1', channel_type: 'whatsapp', created_at: T0, updated_at: T0,
    ai_enabled: 1, followup: 1, buying_intent: 'alta',  pipeline_cards: '[{"id":"card1"}]', labels: '[]', msg_count: 4 },
  { id: 'c2', account_id: 'acc1', agent_id: 'ag1', channel_type: 'webchat',  created_at: T0, updated_at: T0,
    ai_enabled: 0, followup: 0, buying_intent: 'media', pipeline_cards: '[{"id":"card2"}]', labels: '[]', msg_count: 2 },
  { id: 'c3', account_id: 'acc1', agent_id: 'ag1', channel_type: 'webchat',  created_at: T0, updated_at: T0,
    ai_enabled: 1, followup: 0, buying_intent: 'baja',  pipeline_cards: '[]', labels: '[]', msg_count: 2 },
  { id: 'c4', account_id: 'acc1', agent_id: 'ag1', channel_type: 'whatsapp', created_at: T0, updated_at: T0,
    ai_enabled: 1, followup: 0, buying_intent: null,    pipeline_cards: '[]', labels: '[]', msg_count: 2 },
]

// La IA responde a 1 y 3 min (media 2). Una persona responde a 60 y 120 min (media 90).
const mensajes = [
  { conversation_id: 'c1', sender: 'user',  ts: T0,            id: 'm1' },
  { conversation_id: 'c1', sender: 'ai',    ts: T0 + min(1),   id: 'm2' },
  { conversation_id: 'c1', sender: 'user',  ts: T0 + min(10),  id: 'm3' },
  { conversation_id: 'c1', sender: 'ai',    ts: T0 + min(13),  id: 'm4' },
  { conversation_id: 'c2', sender: 'user',  ts: T0,            id: 'm5' },
  { conversation_id: 'c2', sender: 'human', ts: T0 + min(60),  id: 'm6' },
  { conversation_id: 'c3', sender: 'user',  ts: T0,            id: 'm7' },
  { conversation_id: 'c3', sender: 'human', ts: T0 + min(120), id: 'm8' },
]

const CONTEOS = {
  calendar_bookings: 7,     // citas agendadas
  booking_allocations: 3,   // de esas, 3 ocupan recurso → reservas
  crm_tasks: 5,             // seguimientos
  orders: 2,                // pedidos pagados/entregados
}

const raiz = path.resolve(__dirname, '..')
const dobles = {
  [path.join(raiz, 'db.js')]: {
    async query(sql) {
      if (/FROM conversations c/i.test(sql))            return [conversaciones]
      if (/FROM messages m JOIN conversations/i.test(sql)) return [mensajes]
      if (/FROM calendar_bookings b\s*\n?\s*JOIN booking_allocations/i.test(sql) || /JOIN booking_allocations/i.test(sql))
        return [[{ n: CONTEOS.booking_allocations }]]
      if (/FROM calendar_bookings/i.test(sql))          return [[{ n: CONTEOS.calendar_bookings }]]
      if (/FROM crm_tasks/i.test(sql))                  return [[{ n: CONTEOS.crm_tasks }]]
      if (/FROM orders/i.test(sql))                     return [[{ n: CONTEOS.orders }]]
      if (/FROM labels/i.test(sql))                     return [[]]
      if (/FROM token_usage/i.test(sql))                return [[{ t: 0, c: 0 }]]
      if (/FROM pipelines/i.test(sql))                  return [[]]
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

const ctrl = require('../controllers/analytics.controller')

let fallos = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos++ }

;(async () => {
  const res = { cuerpo: null, code: 200 }
  res.status = c => { res.code = c; return res }
  res.json = b => { res.cuerpo = b; return res }
  await ctrl.businessMetrics({ params: { accId: 'acc1' }, query: { from: T0 - min(60), to: T0 + min(600) } }, res)

  if (res.code !== 200) {
    console.log(`  ✗ el endpoint falló (${res.code}): ${res.cuerpo?.error}`)
    process.exit(1)
  }
  const k = res.cuerpo.kpis

  console.log('\n· Tiempos de respuesta, separados')
  ok(k.avgResponseTimeAiMs === min(2), `IA: 2 min (fue ${Math.round(k.avgResponseTimeAiMs / 60000)} min)`)
  ok(k.avgResponseTimeHumanMs === min(90), `personas: 90 min (fue ${Math.round(k.avgResponseTimeHumanMs / 60000)} min)`)
  ok(k.avgResponseTimeAiMs !== k.avgResponseTimeHumanMs,
    'son DISTINTOS — antes salía un único promedio que los mezclaba')
  ok(k.avgResponseTimeMs > k.avgResponseTimeAiMs && k.avgResponseTimeMs < k.avgResponseTimeHumanMs,
    `y el combinado queda en medio (${Math.round(k.avgResponseTimeMs / 60000)} min), como debe`)

  console.log('\n· Métricas de negocio')
  ok(k.appointments === 7,     `citas agendadas: 7 (fue ${k.appointments})`)
  ok(k.reservations === 3,     `reservas: 3 (fue ${k.reservations})`)
  ok(k.followupTasks === 5,    `tareas de seguimiento: 5 (fue ${k.followupTasks})`)
  ok(k.followupChats === 1,    `chats en seguimiento: 1 (fue ${k.followupChats})`)
  ok(k.opportunities === 2,    `oportunidades (con tarjeta): 2 (fue ${k.opportunities})`)
  ok(k.qualifiedLeads === 2,   `consultas calificadas (alta+media): 2 (fue ${k.qualifiedLeads})`)
  ok(k.ordersWon === 2,        `pedidos ganados: 2 (fue ${k.ordersWon})`)
  ok(k.totalConversations === 4, `conversaciones: 4 (fue ${k.totalConversations})`)
  ok(k.conversionRate === 50,  `conversión: 2 de 4 = 50 % (fue ${k.conversionRate})`)

  console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${fallos} comprobación(es) fallida(s)\n`)
  process.exit(fallos ? 1 : 0)
})()
