'use strict'
/**
 * El camino de un mensaje que el asesor escribe a mano.
 *
 *   node pruebas/envio-manual.test.js
 *
 * Comprueba lo que de verdad importa para que el mensaje APAREZCA en el inbox: que se
 * persista, y que el evento de socket lleve `accId` y `agId`. El inbox indexa sus listas por
 * `${accId}_${agId}`; un evento sin esos dos campos cae en una clave que no existe y el
 * mensaje no se pinta en ningún sitio.
 */
const path = require('path')
const Module = require('module')

// ── Dobles de las dependencias del controlador ────────────────────────────────
const emitidos = []
const insertados = []
let convFila = {
  channel_type: 'webchat', channel_id: 'ch1',
  wa_from: null, messenger_from: null, ig_from: null,
}

const pool = {
  async query(sql, params) {
    if (/^\s*INSERT INTO messages/i.test(sql)) { insertados.push(params); return [{ affectedRows: 1 }] }
    if (/FROM conversations WHERE id=\? AND account_id=\?/i.test(sql)) return [convFila ? [convFila] : []]
    if (/SELECT MAX\(ts\)/i.test(sql)) return [[{ ts: Date.now() }]]   // ventana de 24 h abierta
    if (/^\s*UPDATE conversations/i.test(sql)) return [{ affectedRows: 1 }]
    if (/FROM messages WHERE id=\?/i.test(sql)) return [[]]
    // El canal del agente: sin esto `resolveChannelConfig` no encuentra nada y el envío a un
    // canal real falla con «Canal WhatsApp sin configurar».
    if (/SELECT channels FROM agents/i.test(sql)) {
      return [[{ channels: JSON.stringify([
        { id: 'ch1', type: 'whatsapp',  status: 'connected', config: { phoneNumberId: 'pn1', accessToken: 'tok' } },
        { id: 'ch1', type: 'messenger', status: 'connected', config: { pageId: 'pg1', pageAccessToken: 'tok' } },
        { id: 'ch1', type: 'instagram', status: 'connected', config: { igAccountId: 'ig1', pageAccessToken: 'tok' } },
      ]) }]]
    }
    return [[]]
  },
}
const socket = {
  emit(accountId, event, data) { emitidos.push({ sala: `acc:${accountId}`, event, data }) },
  emitToConv(convId, event, data) { emitidos.push({ sala: `conv:${convId}`, event, data }) },
  emitToMember() {}, broadcast() {},
}

const raiz = path.resolve(__dirname, '..')
const dobles = {
  [path.join(raiz, 'db.js')]: pool,
  [path.join(raiz, 'services', 'socket.js')]: socket,
  [path.join(raiz, 'services', 'metaSend.js')]: {
    sendWhatsAppText: async () => ({ messages: [{ id: 'wamid.X' }] }),
    sendMessengerText: async () => ({ message_id: 'mid.X' }),
    sendInstagramText: async () => ({ message_id: 'ig.X' }),
  },
  [path.join(raiz, 'services', 'subscriptions.js')]: {
    sendGate: async () => ({ allowed: true }), markContactActive() {}, incrementConversation() {},
  },
}
const cargarOriginal = Module._load
Module._load = function (pedido, padre, esPrincipal) {
  const resuelto = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (resuelto && dobles[resuelto]) return dobles[resuelto]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const ctrl = require('../controllers/conversations.controller')

// ── Utilidades de prueba ──────────────────────────────────────────────────────
let fallos = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos++ }

function resFalsa() {
  const r = { code: 200, cuerpo: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.cuerpo = b; return r }
  return r
}

async function enviar(canal) {
  emitidos.length = 0; insertados.length = 0
  convFila = {
    channel_type: canal, channel_id: 'ch1',
    wa_from: canal === 'whatsapp' ? '573001112233' : null,
    messenger_from: canal === 'messenger' ? 'psid1' : null,
    ig_from: canal === 'instagram' ? 'igsid1' : null,
  }
  const res = resFalsa()
  await ctrl.sendManual(
    { params: { accId: 'acc1', agId: 'ag1', convId: 'conv1' }, body: { text: 'Hola, ¿sigues ahí?' }, user: { name: 'Ana' } },
    res
  )
  return res
}

;(async () => {
  console.log('\n· Webchat (sin envío externo, solo persistencia)')
  let res = await enviar('webchat')
  ok(res.code === 200, `responde 200 (fue ${res.code}${res.cuerpo?.error ? ' · ' + res.cuerpo.error : ''})`)
  ok(insertados.length === 1, `persiste 1 mensaje (fueron ${insertados.length})`)
  ok(insertados[0]?.[2] === 'human', `se guarda como 'human' (fue ${insertados[0]?.[2]})`)

  const aCuenta = emitidos.filter(e => e.sala === 'acc:acc1' && e.event === 'message:new')
  ok(aCuenta.length === 1, `emite message:new a la sala de la cuenta (fueron ${aCuenta.length})`)
  ok(aCuenta[0]?.data?.accId === 'acc1', 'el evento lleva accId')
  ok(aCuenta[0]?.data?.agId === 'ag1', 'el evento lleva agId')
  ok(aCuenta[0]?.data?.message?.sender === 'human', 'el mensaje del evento va como human')

  // El eco a la sala del chat lo reciben TAMBIÉN los asesores (entran en `conv:` al abrirlo).
  // Si va sin accId/agId, el inbox calcula la clave `undefined_undefined` y no pinta nada.
  const aConv = emitidos.filter(e => e.sala === 'conv:conv1' && e.event === 'message:new')
  ok(aConv.length === 1, `emite el eco a la sala del chat (fueron ${aConv.length})`)
  ok(aConv[0]?.data?.accId === 'acc1' && aConv[0]?.data?.agId === 'ag1',
    `el eco a conv: lleva accId/agId (accId=${aConv[0]?.data?.accId}, agId=${aConv[0]?.data?.agId})`)
  ok(aConv[0]?.data?.convId === 'conv1', 'y el convId, que el visitante usa para filtrar')

  // Los tres canales reales pasan por el MISMO embudo, así que se comprueban los tres: lo que
  // arregla la sincronización en uno tiene que valer en todos.
  for (const canal of ['whatsapp', 'messenger', 'instagram']) {
    console.log(`\n· ${canal} (con entrega al canal)`)
    res = await enviar(canal)
    ok(res.code === 200, `responde 200 (fue ${res.code}${res.cuerpo?.error ? ' · ' + res.cuerpo.error : ''})`)
    ok(insertados.length === 1, 'persiste el mensaje')
    const eco = emitidos.filter(e => e.sala === 'conv:conv1' && e.event === 'message:new')
    ok(eco.length === 1 && eco[0].data.accId === 'acc1' && eco[0].data.agId === 'ag1',
      'el eco a la sala del chat lleva cuenta y agente')
    const aCta = emitidos.filter(e => e.sala === 'acc:acc1' && e.event === 'message:new')
    ok(aCta.length === 1, 'y llega a la sala de la cuenta')
  }

  // Contraste: si la conversación no existe, NO debe persistir ni emitir nada. Sin esto, las
  // comprobaciones de arriba podrían pasar por casualidad.
  console.log('\n· Contraste: conversación inexistente')
  emitidos.length = 0; insertados.length = 0
  convFila = null
  const res2 = resFalsa()
  await ctrl.sendManual({ params: { accId: 'acc1', agId: 'ag1', convId: 'nope' }, body: { text: 'x' }, user: {} }, res2)
  ok(res2.code === 404, `responde 404 (fue ${res2.code})`)
  ok(insertados.length === 0, 'no persiste nada')
  ok(emitidos.length === 0, 'no emite nada')

  console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${fallos} comprobación(es) fallida(s)\n`)
  process.exit(fallos ? 1 : 0)
})()
