'use strict'
/**
 * Borrado COMPLETO de un contacto: su ficha, su memoria, sus conversaciones y su rastro en el CRM.
 *
 * Borrar una conversación dejaba viva la ficha del contacto —nombre, email, teléfono y sobre todo
 * `contacts.memory`, el resumen permanente que la IA recuerda—, así que la misma persona volvía a
 * escribir y `findOrCreateContact` la reconocía por su teléfono: el chat "nuevo" nacía sabiéndolo
 * todo. Quedaban además huérfanos sus mensajes programados, sus notas y su tarjeta de embudo.
 *
 * ── Cómo se decide QUÉ se borra ──────────────────────────────────────────────
 *
 * Las tablas NO se enumeran a mano: se le preguntan al catálogo del motor, igual que en
 * `accountPurge`. Una lista escrita a mano se queda desfasada en cuanto alguien añade una tabla
 * —y nadie se entera, porque el borrado "sigue funcionando"—.
 *
 * Se barre todo lo que apunte a una conversación (`conversation_id` / `conv_id`), a un objetivo
 * del CRM (`target_id`) o a una tarjeta de embudo (`card_id`).
 *
 * ── Y QUÉ NO se borra ────────────────────────────────────────────────────────
 *
 * Un barrido por catálogo es ciego, así que lo que debe sobrevivir se nombra de una en una y con
 * su motivo (ver INTOCABLES). En resumen: el dinero se queda. Los pedidos y los cobros son
 * registros contables y ya guardan el nombre del cliente por su cuenta; el consumo facturado, si
 * se borrase, falsearía la factura. Las citas de la agenda (`calendar_bookings`) no tienen
 * columna de conversación, así que el barrido ni las alcanza.
 *
 * IMPORTANTE: si algún día se crea una tabla nueva que guarde dinero y la cuelgue de la
 * conversación, hay que añadirla a INTOCABLES. La prueba `pruebas/borrado-contacto.test.js` está
 * escrita para que eso se note.
 */
const pool = require('../db')
const { parseJ } = require('../utils')

const INTOCABLES = new Set([
  'orders',                            // pedidos: dinero, y ya llevan customer_name/customer_phone
  'woo_orders',                        // pedidos de WooCommerce: ídem
  'payment_intents',                   // cobros: registro financiero
  'token_usage',                       // consumo facturado: borrarlo falsearía métricas y factura
  'subscription_contact_activity',     // contadores del plan (contactos activos del periodo)
  'subscription_ai_contact_activity',  // ídem, para el límite de contactos con IA
  'conversations',                     // se borran al final: antes hacen falta para localizar todo
  'contacts',                          // ídem
])

const COLUMNAS_CONVERSACION = ['conversation_id', 'conv_id']

const esIdentificador = s => /^[A-Za-z0-9_]+$/.test(String(s || ''))

/** Las tablas del esquema actual que tienen alguna de estas columnas. */
async function tablasCon(columnas) {
  try {
    const [rows] = await pool.query(
      `SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN (?)`,
      [columnas]
    )
    return rows.filter(r => esIdentificador(r.tabla) && esIdentificador(r.columna) && !INTOCABLES.has(r.tabla))
  } catch { return [] }
}

/** Las tablas que llevan `account_id`, para acotar el borrado a la cuenta donde se pueda. */
async function tablasConCuenta() {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT TABLE_NAME AS tabla
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'account_id'`
    )
    return new Set(rows.map(r => r.tabla))
  } catch { return new Set() }
}

/**
 * Borra en cada tabla las filas cuya columna apunte a alguno de estos ids.
 * Se acota por `account_id` donde esa columna exista; donde no (p. ej. `crm_rule_fires`, cuya
 * clave es rule_id+target_id) se confía en que los ids son únicos: llevan prefijo y sufijo `uid`.
 */
async function barrer(columnas, ids, accId, conCuenta, salida) {
  if (!ids.length) return
  for (const { tabla, columna } of await tablasCon(columnas)) {
    const acota = conCuenta.has(tabla)
    const sql = 'DELETE FROM `' + tabla + '` WHERE `' + columna + '` IN (?)' + (acota ? ' AND account_id=?' : '')
    try {
      const [r] = await pool.query(sql, acota ? [ids, accId] : [ids])
      const n = r?.affectedRows || 0
      if (n) { salida.filas += n; salida.tablas[tabla] = (salida.tablas[tabla] || 0) + n }
    } catch (e) {
      // Que una tabla no exista en esta instalación no es un error: el esquema evoluciona.
      if (!/doesn't exist|Unknown table|Unknown column/i.test(e.message)) salida.errores.push(`${tabla}: ${e.message}`)
    }
  }
}

/** Conversaciones de un contacto. El vínculo vive DENTRO de local_vars, no en una columna. */
async function conversacionesDe(accId, contactId) {
  try {
    const [rows] = await pool.query(
      `SELECT id, agent_id FROM conversations
        WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars,'$.contact_id'))=?`,
      [accId, contactId]
    )
    return rows
  } catch { return [] }
}

/**
 * Retira del CRM las tarjetas de este contacto. Viven dentro del JSON `pipelines.cards`, así que
 * no hay DELETE que valga: se reescribe la lista. Devuelve los ids retirados, que hacen falta
 * DESPUÉS para borrar lo que colgaba de ellas (notas, historial de etapas, relaciones).
 */
async function retirarTarjetas(accId, contactId, convIds) {
  const retiradas = []
  try {
    const [pipes] = await pool.query('SELECT id, cards FROM pipelines WHERE account_id=?', [accId])
    const deEsteChat = new Set(convIds)
    for (const p of pipes) {
      const cards = parseJ(p.cards, [])
      const quedan = cards.filter(c => {
        const suya = (contactId && c.contactId === contactId) || (c.convId && deEsteChat.has(c.convId))
        if (suya && c.id) retiradas.push(c.id)
        return !suya
      })
      if (quedan.length !== cards.length) {
        await pool.query('UPDATE pipelines SET cards=? WHERE id=? AND account_id=?', [JSON.stringify(quedan), p.id, accId])
      }
    }
  } catch { /* best-effort: el resto del borrado sigue */ }
  return retiradas
}

const vacio = () => ({ contactoBorrado: false, conversaciones: [], agentes: [], filas: 0, tablas: {}, errores: [] })

/**
 * Borra un contacto y TODO lo suyo.
 * @returns {Promise<{contactoBorrado:boolean, conversaciones:string[], agentes:string[], filas:number, tablas:object, errores:string[]}>}
 */
async function purgeContact(accId, contactId) {
  const salida = vacio()
  if (!accId || !contactId) return salida

  const convos = await conversacionesDe(accId, contactId)
  const convIds = convos.map(c => c.id)
  salida.conversaciones = convIds
  salida.agentes = [...new Set(convos.map(c => c.agent_id).filter(Boolean))]

  const conCuenta = await tablasConCuenta()

  // 1) Las tarjetas primero: hacen falta sus ids para borrar lo que cuelga de ellas.
  const cardIds = await retirarTarjetas(accId, contactId, convIds)
  await barrer(['card_id'], cardIds, accId, conCuenta, salida)
  if (cardIds.length) {
    try {
      const [r] = await pool.query(
        'DELETE FROM crm_card_links WHERE account_id=? AND (a_card IN (?) OR b_card IN (?))',
        [accId, cardIds, cardIds])
      salida.filas += r?.affectedRows || 0
    } catch { /* la tabla puede no existir en esta instalación */ }
  }

  // 2) Notas, tareas, actividad y disparos de reglas. Se casa por `target_id` y NO por
  //    (target_type, target_id) a propósito: los ids ya son únicos y con prefijo —contact_,
  //    conv_, card_—, así que no hace falta acertar con la etiqueta ('conv' vs 'conversation').
  await barrer(['target_id'], [contactId, ...convIds, ...cardIds], accId, conCuenta, salida)

  // 3) Todo lo que cuelgue de sus conversaciones: mensajes, media, mensajes programados…
  await barrer(COLUMNAS_CONVERSACION, convIds, accId, conCuenta, salida)

  // 4) Las conversaciones.
  if (convIds.length) {
    try {
      const [r] = await pool.query('DELETE FROM conversations WHERE id IN (?) AND account_id=?', [convIds, accId])
      salida.filas += r?.affectedRows || 0
      salida.tablas.conversations = r?.affectedRows || 0
    } catch (e) { salida.errores.push(`conversations: ${e.message}`) }
  }

  // 5) Y la ficha, al final.
  try {
    const [r] = await pool.query('DELETE FROM contacts WHERE id=? AND account_id=?', [contactId, accId])
    salida.contactoBorrado = (r?.affectedRows || 0) > 0
    salida.filas += r?.affectedRows || 0
  } catch (e) { salida.errores.push(`contacts: ${e.message}`) }

  if (salida.errores.length) console.warn('[purgeContact]', contactId, salida.errores.join(' · '))
  return salida
}

/** Borra una sola conversación y lo que cuelgue de ella. Sin tocar contacto alguno. */
async function purgeSoloConversacion(accId, conv, salida) {
  salida.conversaciones = [conv.id]
  salida.agentes = conv.agent_id ? [conv.agent_id] : []
  await barrer(COLUMNAS_CONVERSACION, [conv.id], accId, await tablasConCuenta(), salida)
  try {
    const [r] = await pool.query('DELETE FROM conversations WHERE id=? AND account_id=?', [conv.id, accId])
    salida.filas += r?.affectedRows || 0
    salida.tablas.conversations = r?.affectedRows || 0
  } catch (e) { salida.errores.push(`conversations: ${e.message}`) }
  return salida
}

/**
 * Borra una conversación. Si tiene contacto, se lleva al contacto entero (y con él sus demás
 * conversaciones). Si no lo tiene —chats viejos, canal de pruebas— borra solo esta.
 */
async function purgeConversation(accId, convId) {
  const salida = vacio()
  if (!accId || !convId) return salida

  let conv = null
  try {
    const [[row]] = await pool.query('SELECT id, agent_id, local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    conv = row || null
  } catch (e) { salida.errores.push(`conversations: ${e.message}`) }
  if (!conv) return salida

  const contactId = parseJ(conv.local_vars, {})?.contact_id || null
  if (!contactId) return purgeSoloConversacion(accId, conv, salida)

  const r = await purgeContact(accId, contactId)
  // El chat pedido podría no salir en la lista del contacto si su `local_vars` quedó
  // desincronizado. Se borra igualmente: lo contrario sería ver seguir ahí justo el que se
  // mandó borrar.
  if (!r.conversaciones.includes(convId)) {
    const solo = await purgeSoloConversacion(accId, conv, vacio())
    r.conversaciones.push(...solo.conversaciones)
    r.agentes = [...new Set([...r.agentes, ...solo.agentes])]
    r.filas += solo.filas
    r.errores.push(...solo.errores)
  }
  return r
}

module.exports = { purgeContact, purgeConversation, INTOCABLES }
