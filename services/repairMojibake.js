'use strict'
/**
 * Reparación del texto corrompido por el bug del JWT (`ñ` → `Ã±`).
 *
 * Durante un tiempo el frontend leyó el nombre del usuario del token con `atob()`, que
 * devuelve bytes en vez de UTF-8. Ese nombre roto se guardó en la BD cada vez que alguien
 * escribió un mensaje, una nota o una tarea, así que el historial quedó con "MuÃ±oz".
 *
 * Aquí se deshace: se reinterpretan los bytes como UTF-8 (la inversa exacta del daño).
 *
 * Precauciones:
 *  · Solo se tocan filas que contienen el patrón del mojibake (`Ã` o `Â`).
 *  · Cada valor se valida ANTES de escribir: si al convertirlo aparece el carácter de
 *    reemplazo (), no era mojibake y se deja como está. Así un nombre legítimo con `Ã`
 *    (portugués, p. ej. "JoÃO" mal escrito a mano) no se destroza.
 *  · Es idempotente: tras repararse, la fila deja de coincidir con el patrón.
 *  · Corre en segundo plano y por lotes: no retrasa el arranque.
 */
const pool = require('../db')

const BATCH = 500

// Los bytes 0x80-0x9F no son imprimibles en latin1, así que según por dónde haya pasado el
// texto aparecen como caracteres de control (0x91) o como los símbolos de Windows-1252
// (0x91 → '). Hay que aceptar ambas formas o se escaparían nombres con Ñ, Í, Ó…
const CP1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F }

// Secuencias que solo aparecen cuando UTF-8 se leyó como latin1. Si el texto no contiene
// ninguna, no es mojibake (evita tocar textos que legítimamente llevan Ã o Â sueltas).
const TRAIL = '[\\x80-\\xBF' + Object.keys(CP1252).join('') + ']'
const MOJIBAKE = new RegExp('[ÃÂ]' + TRAIL)

// "MuÃ±oz" → "Muñoz". Devuelve null si el valor no era mojibake reparable.
function fix(value) {
  if (typeof value !== 'string' || !value) return null
  if (!MOJIBAKE.test(value)) return null
  // Cada carácter vuelve a ser el byte que era antes de leerse mal.
  const bytes = []
  for (const ch of value) {
    const cp = ch.codePointAt(0)
    if (cp <= 0xFF) bytes.push(cp)
    else if (CP1252[ch] !== undefined) bytes.push(CP1252[ch])
    else return null            // carácter que no proviene de un byte → no era mojibake
  }
  let out
  try { out = Buffer.from(bytes).toString('utf8') } catch { return null }
  // El carácter de reemplazo significa que los bytes no eran UTF-8 válido → no tocar.
  if (!out || out.includes('�') || out === value) return null
  return out
}

// Repara una columna de texto plano de una tabla.
async function repairColumn(table, idCol, col) {
  let fixed = 0
  try {
    const [rows] = await pool.query(
      `SELECT ${idCol} AS id, ${col} AS val FROM ${table}
       WHERE ${col} IS NOT NULL AND (${col} LIKE '%Ã%' OR ${col} LIKE '%Â%') LIMIT ${BATCH}`
    )
    for (const r of rows) {
      const next = fix(r.val)
      if (!next) continue
      await pool.query(`UPDATE ${table} SET ${col}=? WHERE ${idCol}=?`, [next, r.id])
      fixed++
    }
  } catch { /* tabla o columna inexistente en esta instalación */ }
  return fixed
}

// Repara claves de texto dentro de una columna JSON (p. ej. metadata.senderName).
async function repairJsonKeys(table, idCol, col, keys) {
  let fixed = 0
  try {
    const [rows] = await pool.query(
      `SELECT ${idCol} AS id, ${col} AS val FROM ${table}
       WHERE ${col} IS NOT NULL AND (${col} LIKE '%Ã%' OR ${col} LIKE '%Â%') LIMIT ${BATCH}`
    )
    for (const r of rows) {
      let obj
      try { obj = typeof r.val === 'string' ? JSON.parse(r.val) : r.val } catch { continue }
      if (!obj || typeof obj !== 'object') continue
      let touched = false
      for (const k of keys) {
        const next = fix(obj[k])
        if (next) { obj[k] = next; touched = true }
      }
      if (!touched) continue
      await pool.query(`UPDATE ${table} SET ${col}=? WHERE ${idCol}=?`, [JSON.stringify(obj), r.id])
      fixed++
    }
  } catch { /* tabla o columna inexistente */ }
  return fixed
}

// Pasada completa. Best-effort: nunca lanza.
async function run() {
  let total = 0
  total += await repairColumn('crm_notes', 'id', 'author_name')
  total += await repairColumn('crm_tasks', 'id', 'assignee_name')
  total += await repairColumn('crm_tasks', 'id', 'created_by')
  total += await repairColumn('crm_activity', 'id', 'author_name')
  total += await repairColumn('support_messages', 'id', 'author_name')
  total += await repairColumn('team_chat', 'id', 'author_name')
  // Nombre del remitente que se muestra en cada burbuja del chat.
  total += await repairJsonKeys('messages', 'id', 'metadata', ['senderName'])
  // Asesor asignado a la conversación ({ id, name }).
  total += await repairJsonKeys('conversations', 'id', 'assigned_to', ['name'])
  if (total) console.log(`[repair] texto con caracteres corruptos reparado en ${total} fila(s)`)
  return total
}

// Arranca en segundo plano y repite mientras siga encontrando filas rotas (los lotes son
// de 500), con pausas para no competir con el tráfico normal.
function start() {
  setTimeout(async function pass() {
    try {
      const n = await run()
      if (n >= BATCH) setTimeout(pass, 30000)   // quedaban más: otra tanda
    } catch (e) { console.warn('[repair]', e.message) }
  }, 25000)
}

module.exports = { run, start, fix }
