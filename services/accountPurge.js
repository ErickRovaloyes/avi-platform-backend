'use strict'
/**
 * Borrado COMPLETO de una cuenta y de todo lo que cuelga de ella.
 *
 * `DELETE FROM accounts` a secas no bastaba: en el esquema no hay ni una sola clave foránea
 * con ON DELETE CASCADE, así que borrar la cuenta dejaba huérfanas sus conversaciones,
 * mensajes, contactos, pedidos, flujos… en casi cien tablas. Para un borrado que pide el
 * propio dueño eso es inaceptable: dijo que se borra su cuenta, y sus datos deben irse con
 * ella.
 *
 * Las tablas NO se enumeran a mano: se preguntan al catálogo del propio motor. Una lista
 * escrita a mano se queda desfasada en cuanto alguien añade una tabla —y nadie se entera,
 * porque el borrado sigue "funcionando"—.
 */
const pool = require('../db')

// Tablas que NO cuelgan de la cuenta por `account_id` sino de un padre intermedio. Se borran
// antes que su padre, o se quedaría sin forma de encontrarlas.
const HIJAS = [
  { tabla: 'messages', sql: 'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE account_id=?)' },
  { tabla: 'support_messages', sql: 'DELETE FROM support_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE account_id=?)' },
]

/**
 * @returns {Promise<{tablas:number, filas:number, errores:string[]}>}
 */
async function purgeAccount(accId) {
  const errores = []
  let filas = 0
  let tablas = 0

  // 1) Hijas de hijas, primero.
  for (const h of HIJAS) {
    try {
      const [r] = await pool.query(h.sql, [accId])
      filas += r?.affectedRows || 0
      tablas++
    } catch (e) {
      // Si una tabla no existe en esta instalación no es un error: se sigue.
      if (!/doesn't exist|Unknown table/i.test(e.message)) errores.push(`${h.tabla}: ${e.message}`)
    }
  }

  // 2) Todo lo que tenga `account_id`, según el catálogo del motor.
  let conAccountId = []
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT TABLE_NAME AS t
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND COLUMN_NAME = 'account_id'
          AND TABLE_NAME <> 'accounts'`
    )
    conAccountId = rows.map(r => r.t)
  } catch (e) {
    errores.push(`no se pudo listar las tablas: ${e.message}`)
  }

  for (const t of conAccountId) {
    try {
      // El nombre viene del catálogo del propio motor, no de la petición: no hay dónde
      // inyectar. Aun así se acota a lo que puede ser un identificador válido.
      if (!/^[A-Za-z0-9_]+$/.test(t)) continue
      const [r] = await pool.query(`DELETE FROM \`${t}\` WHERE account_id=?`, [accId])
      filas += r?.affectedRows || 0
      tablas++
    } catch (e) { errores.push(`${t}: ${e.message}`) }
  }

  // 3) La cuenta, al final.
  try {
    const [r] = await pool.query('DELETE FROM accounts WHERE id=?', [accId])
    filas += r?.affectedRows || 0
    tablas++
  } catch (e) { errores.push(`accounts: ${e.message}`) }

  return { tablas, filas, errores }
}

module.exports = { purgeAccount }
