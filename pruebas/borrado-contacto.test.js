'use strict'
/**
 * Borrar una conversación borra también al contacto.
 *
 *   node pruebas/borrado-contacto.test.js
 *
 * El fallo, tal como se veía: borras el chat y la ficha del contacto sigue ahí con su nombre, su
 * email y —lo llamativo— el resumen permanente que la IA recuerda. Cuando esa persona volvía a
 * escribir, `findOrCreateContact` la reconocía por el teléfono y el chat "nuevo" nacía sabiéndolo
 * todo. `deleteConvo` borraba tres cosas (messages, media y la fila del chat) y nada más.
 *
 * Lo que se comprueba aquí no es solo que se borre mucho, sino que se borre EXACTAMENTE lo
 * acordado: la ficha, la memoria, las demás conversaciones y el rastro del CRM… y que el dinero
 * —pedidos, cobros, consumo facturado— y las citas de la agenda sigan intactos. Esa segunda
 * mitad es la que de verdad está en peligro, porque el barrido va por el catálogo del motor y es
 * ciego: lo único que protege a esas tablas es la lista INTOCABLES.
 */
const path = require('path')
const Module = require('module')

let fallos = 0
const ok = (c, m) => { console.log('  ' + (c ? 'OK ' : 'XX ') + m); if (!c) fallos++ }

const raiz = path.resolve(__dirname, '..')
const cargarOriginal = Module._load

// ── La base de datos de mentira ───────────────────────────────────────────────
//
// El esquema y los datos salen del MISMO sitio: así, cuando la prueba añade una tabla, el
// catálogo que ve el servicio la incluye sola. Es justo lo que hace el barrido en producción.
const ESQUEMA = {
  conversations:       ['id', 'account_id', 'agent_id', 'local_vars'],
  contacts:            ['id', 'account_id', 'name', 'email', 'phone', 'memory'],
  messages:            ['id', 'conversation_id', 'content'],
  media:               ['id', 'account_id', 'conversation_id'],
  scheduled_messages:  ['id', 'account_id', 'conversation_id', 'status'],
  flow_executions:     ['id', 'account_id', 'conv_id'],
  crm_notes:           ['id', 'account_id', 'target_type', 'target_id', 'content'],
  crm_tasks:           ['id', 'account_id', 'target_type', 'target_id', 'title'],
  crm_activity:        ['id', 'account_id', 'target_type', 'target_id'],
  crm_rule_fires:      ['rule_id', 'target_id', 'fired_at'],          // sin account_id, a propósito
  deal_stage_history:  ['account_id', 'pipeline_id', 'card_id', 'to_stage'],
  crm_card_links:      ['id', 'account_id', 'a_card', 'b_card'],
  pipelines:           ['id', 'account_id', 'name', 'cards'],
  // Dinero. Cuelga de la conversación igual que lo demás: si no estuviera en INTOCABLES, el
  // barrido se lo llevaría sin que nadie se enterase.
  orders:              ['id', 'account_id', 'conv_id', 'contact_id', 'total'],
  woo_orders:          ['id', 'account_id', 'conv_id', 'total'],
  payment_intents:     ['id', 'account_id', 'conv_id', 'amount'],
  token_usage:         ['id', 'account_id', 'conversation_id', 'total_tokens'],
  // La agenda no tiene columna de conversación: el barrido ni la alcanza.
  calendar_bookings:   ['id', 'account_id', 'calendar_id', 'client_name'],
}

let tablas = {}
const formasDesconocidas = []   // SQL que el doble no supo interpretar (se revisa al final)

const filas = t => (tablas[t] || [])
const conta = t => filas(t).length
const ids = t => filas(t).map(r => r.id)

const pool = {
  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim()

    // ── El catálogo del motor ────────────────────────────────────────────────
    if (/information_schema/i.test(s)) {
      if (/COLUMN_NAME = 'account_id'/.test(s)) {
        return [Object.entries(ESQUEMA).filter(([, c]) => c.includes('account_id')).map(([t]) => ({ tabla: t }))]
      }
      const buscadas = params[0] || []
      const out = []
      for (const [t, cols] of Object.entries(ESQUEMA)) {
        for (const c of cols) if (buscadas.includes(c)) out.push({ tabla: t, columna: c })
      }
      return [out]
    }

    // ── SELECT ───────────────────────────────────────────────────────────────
    if (/^SELECT id, agent_id, local_vars FROM conversations WHERE id=\? AND account_id=\?/.test(s)) {
      return [filas('conversations').filter(r => r.id === params[0] && r.account_id === params[1])]
    }
    if (/^SELECT id, agent_id FROM conversations WHERE account_id=\? AND JSON_UNQUOTE/.test(s)) {
      return [filas('conversations').filter(r => {
        if (r.account_id !== params[0]) return false
        try { return (JSON.parse(r.local_vars || '{}') || {}).contact_id === params[1] } catch { return false }
      })]
    }
    if (/^SELECT id, cards FROM pipelines WHERE account_id=\?/.test(s)) {
      return [filas('pipelines').filter(r => r.account_id === params[0])]
    }
    if (/^SELECT memory FROM contacts WHERE id=\? AND account_id=\?/.test(s)) {
      return [filas('contacts').filter(r => r.id === params[0] && r.account_id === params[1])]
    }
    if (/^SELECT id, memory FROM contacts WHERE account_id=\? AND phone=\?/.test(s)) {
      return [filas('contacts').filter(r => r.account_id === params[0] && r.phone === params[1])]
    }

    // ── UPDATE ───────────────────────────────────────────────────────────────
    if (/^UPDATE pipelines SET cards=\? WHERE id=\? AND account_id=\?/.test(s)) {
      const p = filas('pipelines').find(r => r.id === params[1] && r.account_id === params[2])
      if (p) p.cards = params[0]
      return [{ affectedRows: p ? 1 : 0 }]
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    const del = s.match(/^DELETE FROM `?(\w+)`? WHERE (.+)$/i)
    if (del) {
      const t = del[1]; const donde = del[2]
      const antes = conta(t)
      let sobrevive = null

      let m = donde.match(/^`?(\w+)`? IN \(\?\)( AND account_id=\?)?$/i)
      if (m) {
        const col = m[1], acota = !!m[2]
        const lista = params[0] || []
        sobrevive = r => !(lista.includes(r[col]) && (!acota || r.account_id === params[1]))
      }
      if (!sobrevive && /^id IN \(\?\) AND account_id=\?$/i.test(donde)) {
        const lista = params[0] || []
        sobrevive = r => !(lista.includes(r.id) && r.account_id === params[1])
      }
      if (!sobrevive && /^id=\? AND account_id=\?$/i.test(donde)) {
        sobrevive = r => !(r.id === params[0] && r.account_id === params[1])
      }
      if (!sobrevive && /^account_id=\? AND \(a_card IN \(\?\) OR b_card IN \(\?\)\)$/i.test(donde)) {
        const a = params[1] || [], b = params[2] || []
        sobrevive = r => !(r.account_id === params[0] && (a.includes(r.a_card) || b.includes(r.b_card)))
      }
      if (!sobrevive) {
        // Un doble que no entiende la consulta y devuelve 0 filas haría pasar la prueba por el
        // motivo equivocado. Se anota y se revisa al final.
        formasDesconocidas.push(s.slice(0, 90))
        return [{ affectedRows: 0 }]
      }
      tablas[t] = filas(t).filter(sobrevive)
      return [{ affectedRows: antes - conta(t) }]
    }

    formasDesconocidas.push(s.slice(0, 90))
    return [[]]
  },
}

const emitidos = []
const dobles = {
  [path.join(raiz, 'db.js')]: pool,
  [path.join(raiz, 'services', 'socket.js')]: {
    emit: (accId, ev, data) => emitidos.push({ accId, ev, data }),
    emitToConv() {}, emitToMember() {},
  },
}
Module._load = function (pedido, padre, esPrincipal) {
  const r = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (r && dobles[r]) return dobles[r]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const purga = require('../services/contactPurge')
const convos = require('../controllers/conversations.controller')
const { getContactMemory } = require('../services/conversationMemory')

const ACC = 'acc1'
const TELEFONO = '573001112233'

/**
 * El escenario: un contacto con DOS conversaciones en agentes distintos, con todo lo que la
 * plataforma le va colgando encima. Y un segundo contacto que no tiene nada que ver, para que se
 * vea que el borrado no se lleva por delante al vecino.
 */
function sembrar() {
  emitidos.length = 0
  formasDesconocidas.length = 0
  tablas = {
    conversations: [
      { id: 'conv_A', account_id: ACC, agent_id: 'ag1', local_vars: JSON.stringify({ contact_id: 'contact_1', user_name: 'Ana' }) },
      { id: 'conv_B', account_id: ACC, agent_id: 'ag2', local_vars: JSON.stringify({ contact_id: 'contact_1' }) },
      { id: 'conv_C', account_id: ACC, agent_id: 'ag1', local_vars: JSON.stringify({ contact_id: 'contact_2' }) },
      { id: 'conv_suelta', account_id: ACC, agent_id: 'ag1', local_vars: JSON.stringify({ user_name: 'Visitante' }) },
    ],
    contacts: [
      { id: 'contact_1', account_id: ACC, name: 'Ana', email: 'ana@correo.com', phone: TELEFONO, memory: 'DATOS DEL CLIENTE: Ana, quiere una suite con vista al mar.' },
      { id: 'contact_2', account_id: ACC, name: 'Beto', email: 'beto@correo.com', phone: '573009998877', memory: 'DATOS DEL CLIENTE: Beto.' },
    ],
    messages: [
      { id: 'm1', conversation_id: 'conv_A', content: 'hola' },
      { id: 'm2', conversation_id: 'conv_A', content: 'mándame fotos' },
      { id: 'm3', conversation_id: 'conv_B', content: 'buenas' },
      { id: 'm4', conversation_id: 'conv_C', content: 'de Beto' },
      { id: 'm5', conversation_id: 'conv_suelta', content: 'sin contacto' },
    ],
    media: [{ id: 'md1', account_id: ACC, conversation_id: 'conv_A' }],
    scheduled_messages: [
      { id: 'sc1', account_id: ACC, conversation_id: 'conv_B', status: 'pending' },
      { id: 'sc2', account_id: ACC, conversation_id: 'conv_C', status: 'pending' },
    ],
    flow_executions: [{ id: 'fe1', account_id: ACC, conv_id: 'conv_A' }],
    crm_notes: [
      { id: 'n1', account_id: ACC, target_type: 'contact', target_id: 'contact_1', content: 'llamar el martes' },
      { id: 'n2', account_id: ACC, target_type: 'conversation', target_id: 'conv_A', content: 'pidió factura' },
      { id: 'n3', account_id: ACC, target_type: 'card', target_id: 'card_1', content: 'negociando' },
      { id: 'n4', account_id: ACC, target_type: 'contact', target_id: 'contact_2', content: 'de Beto' },
    ],
    crm_tasks: [
      { id: 'tk1', account_id: ACC, target_type: 'contact', target_id: 'contact_1', title: 'enviar cotización' },
      { id: 'tk2', account_id: ACC, target_type: 'contact', target_id: 'contact_2', title: 'de Beto' },
    ],
    crm_activity: [{ id: 'ac1', account_id: ACC, target_type: 'conversation', target_id: 'conv_B' }],
    crm_rule_fires: [
      { rule_id: 'r1', target_id: 'contact_1', fired_at: 1 },
      { rule_id: 'r1', target_id: 'contact_2', fired_at: 1 },
    ],
    deal_stage_history: [{ account_id: ACC, pipeline_id: 'pipe1', card_id: 'card_1', to_stage: 'st2' }],
    crm_card_links: [{ id: 'cl1', account_id: ACC, a_card: 'card_1', b_card: 'card_otro' }],
    pipelines: [{
      id: 'pipe1', account_id: ACC, name: 'Ventas',
      cards: JSON.stringify([
        { id: 'card_1', contactId: 'contact_1', convId: 'conv_A', title: 'Oportunidad — Ana' },
        { id: 'card_2', convId: 'conv_B', title: 'Segunda de Ana' },
        { id: 'card_beto', contactId: 'contact_2', convId: 'conv_C', title: 'Oportunidad — Beto' },
        { id: 'card_otro', title: 'Sin dueño' },
      ]),
    }],
    orders:          [{ id: 'ord1', account_id: ACC, conv_id: 'conv_A', contact_id: 'contact_1', total: 250000 }],
    woo_orders:      [{ id: 'wo1', account_id: ACC, conv_id: 'conv_B', total: 90000 }],
    payment_intents: [{ id: 'pi1', account_id: ACC, conv_id: 'conv_A', amount: 250000 }],
    token_usage:     [{ id: 'tu1', account_id: ACC, conversation_id: 'conv_A', total_tokens: 1800 }],
    calendar_bookings: [{ id: 'bk1', account_id: ACC, calendar_id: 'cal1', client_name: 'Ana' }],
  }
}

const cartas = t => JSON.parse(filas('pipelines')[0]?.cards || '[]').map(c => c.id)

;(async () => {
  console.log('\n· Borrar una conversación se lleva al contacto entero')
  sembrar()
  {
    const r = await purga.purgeConversation(ACC, 'conv_A')

    ok(!filas('contacts').some(c => c.id === 'contact_1'), 'la ficha del contacto desaparece')
    ok(await getContactMemory(ACC, 'contact_1') === '',
      'y con ella la memoria: `getContactMemory` —la que lee el nodo IA— ya no devuelve nada')
    ok(!ids('conversations').includes('conv_A'), 'la conversación que se mandó borrar, fuera')
    ok(!ids('conversations').includes('conv_B'),
      'y también la OTRA conversación suya, que era lo acordado')
    ok(r.agentes.length === 2 && r.agentes.includes('ag1') && r.agentes.includes('ag2'),
      `devuelve los DOS agentes afectados, no solo el del chat borrado (${r.agentes.join(', ')})`)
  }

  console.log('\n· Y todo lo que colgaba de ella')
  {
    ok(ids('messages').join() === 'm4,m5', `solo quedan los mensajes ajenos (${ids('messages').join()})`)
    ok(conta('media') === 0, 'la media del chat')
    ok(ids('scheduled_messages').join() === 'sc2',
      'los mensajes programados pendientes — si no, el recontacto dispararía sobre un chat que ya no existe')
    ok(conta('flow_executions') === 0, 'el registro de ejecuciones de flujo')
    ok(ids('crm_notes').join() === 'n4', `las notas del contacto, del chat y de su tarjeta (${ids('crm_notes').join()})`)
    ok(ids('crm_tasks').join() === 'tk2', 'sus tareas')
    ok(conta('crm_activity') === 0, 'su actividad')
    ok(filas('crm_rule_fires').length === 1 && filas('crm_rule_fires')[0].target_id === 'contact_2',
      'y los disparos de reglas, aunque esa tabla no tenga account_id')
    ok(cartas().join() === 'card_beto,card_otro',
      `las tarjetas del embudo, que viven dentro de un JSON (${cartas().join()})`)
    ok(conta('deal_stage_history') === 0, 'el historial de etapas de la tarjeta')
    ok(conta('crm_card_links') === 0, 'y sus relaciones con otras tarjetas')
  }

  console.log('\n· El contraste que sostiene el acuerdo: el dinero NO se toca')
  {
    // El barrido va por el catálogo y es ciego: estas cuatro tablas cuelgan de la conversación
    // exactamente igual que `messages`. Lo único que las salva es la lista INTOCABLES.
    ok(conta('orders') === 1, 'el pedido sigue ahí')
    ok(conta('woo_orders') === 1, 'el pedido de WooCommerce también')
    ok(conta('payment_intents') === 1, 'el cobro, igual')
    ok(conta('token_usage') === 1, 'y el consumo facturado: borrarlo falsearía la factura')
    ok(conta('calendar_bookings') === 1, 'la cita de la agenda ni se roza')

    for (const t of ['orders', 'woo_orders', 'payment_intents', 'token_usage']) {
      ok(purga.INTOCABLES.has(t), `y es por la lista, no por casualidad: INTOCABLES incluye ${t}`)
    }
  }

  console.log('\n· El vecino no paga el plato')
  {
    ok(ids('conversations').includes('conv_C'), 'la conversación del otro contacto sigue')
    ok(filas('contacts').length === 1 && filas('contacts')[0].id === 'contact_2', 'y su ficha')
  }

  console.log('\n· Una tabla nueva SÍ entra en el barrido (por eso hace falta la lista)')
  {
    // Si el barrido no fuese ciego, la protección de arriba no probaría nada. Aquí se le añade
    // al esquema una tabla que nadie ha declarado intocable, y tiene que caer sola.
    sembrar()
    ESQUEMA.cobros_nuevos = ['id', 'account_id', 'conv_id', 'importe']
    tablas.cobros_nuevos = [{ id: 'cn1', account_id: ACC, conv_id: 'conv_A', importe: 100 }]
    try {
      await purga.purgeConversation(ACC, 'conv_A')
      ok(conta('cobros_nuevos') === 0,
        'una tabla no listada se barre sin preguntar — si mañana guarda dinero, hay que añadirla a INTOCABLES')
    } finally { delete ESQUEMA.cobros_nuevos }
  }

  console.log('\n· Un chat sin contacto se borra limpio')
  {
    sembrar()
    const r = await purga.purgeConversation(ACC, 'conv_suelta')
    ok(!ids('conversations').includes('conv_suelta'), 'la conversación se va')
    ok(!ids('messages').includes('m5'), 'y sus mensajes')
    ok(filas('contacts').length === 2, 'sin tocar ninguna ficha')
    ok(r.contactoBorrado === false, 'y lo dice: no había contacto que borrar')
    ok(ids('conversations').includes('conv_A') && ids('conversations').includes('conv_B'),
      'los demás chats siguen donde estaban')
  }

  console.log('\n· El síntoma, en sus términos: vuelve a escribir y entra como cliente nuevo')
  {
    sembrar()
    // Se llama al controlador de verdad, con su ruta y su emisión de eventos.
    let respuesta = null
    await convos.deleteConvo(
      { params: { accId: ACC, agId: 'ag1', convId: 'conv_A' }, user: { id: 'u1' } },
      { json: d => { respuesta = d }, status: () => ({ json: d => { respuesta = d } }) },
    )
    ok(respuesta?.ok === true && respuesta.contactoBorrado === true, 'el endpoint responde que borró el contacto')
    ok(emitidos.filter(e => e.ev === 'convos:updated').length === 2,
      `y refresca la bandeja de los dos agentes (${emitidos.filter(e => e.ev === 'convos:updated').length})`)

    // Ésta es LA consulta con la que `findOrCreateContact` reconoce a quien vuelve por WhatsApp.
    const [encontrados] = await pool.query('SELECT id, memory FROM contacts WHERE account_id=? AND phone=?', [ACC, TELEFONO])
    ok(encontrados.length === 0,
      'con su mismo teléfono ya no hay a quién reconocer: el chat siguiente nace de cero, sin nombre y sin memoria')
  }

  console.log('\n· Borrar el contacto desde el CRM acaba en el mismo sitio')
  {
    sembrar()
    const contactos = require('../controllers/contacts.controller')
    await contactos.remove(
      { params: { accId: ACC, id: 'contact_1' } },
      { json: () => {}, status: () => ({ json: () => {} }) },
    )
    ok(conta('crm_notes') === 1 && conta('crm_tasks') === 1,
      'sus notas y tareas también caen — antes esta puerta borraba los chats y las dejaba vivas')
    ok(cartas().join() === 'card_beto,card_otro', 'y sus tarjetas del embudo')
    ok(conta('orders') === 1, 'y el dinero se conserva igual que por la otra puerta')
  }

  ok(formasDesconocidas.length === 0,
    `el doble entendió todas las consultas${formasDesconocidas.length ? ' — sin interpretar: ' + formasDesconocidas.join(' | ') : ''}`)

  console.log('\n' + (fallos === 0 ? 'OK' : 'FALLA') + '  ' + fallos + ' comprobacion(es) fallida(s)\n')
  process.exit(fallos ? 1 : 0)
})()
