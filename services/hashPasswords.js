'use strict'
/**
 * Migración: convierte a hash las contraseñas que quedaron guardadas en TEXTO PLANO.
 *
 * Se puede hacer de golpe precisamente porque estaban en claro: conocemos la contraseña,
 * así que se puede hashear sin pedirle nada a nadie y sin echar a ningún usuario. El login
 * ya acepta los dos formatos mientras esto termina.
 *
 * Va en segundo plano y a ritmo lento a propósito: bcrypt cuesta ~100 ms por contraseña
 * (y ese coste es el que la hace segura), así que hacerlo todo de una vez al arrancar
 * bloquearía el proceso. Es idempotente: cuando no queda nada en claro, no hace nada.
 */
const pool = require('../db')
const pw = require('./passwords')

const BATCH = 50          // filas por pasada
const PAUSE_MS = 2000     // respiro entre pasadas, para no acaparar la CPU

async function migrateTable(table) {
  // El patrón '$2_$__$%' descarta lo que ya es un hash bcrypt sin traerse la tabla entera.
  const [rows] = await pool.query(
    `SELECT id, password FROM ${table}
     WHERE password IS NOT NULL AND password <> '' AND password NOT LIKE '$2%$%'
     LIMIT ${BATCH}`
  )
  let done = 0
  for (const r of rows) {
    if (pw.isHash(r.password)) continue         // cinturón y tirantes
    try {
      await pool.query(`UPDATE ${table} SET password=? WHERE id=?`, [await pw.hash(r.password), r.id])
      done++
    } catch (e) { console.warn(`[passwords] ${table}#${r.id}:`, e.message) }
  }
  return { found: rows.length, done }
}

async function run() {
  let total = 0
  for (const table of ['members', 'super_admins']) {
    try {
      const r = await migrateTable(table)
      total += r.done
      if (r.done) console.log(`[passwords] ${table}: ${r.done} contraseña(s) hasheada(s)`)
    } catch (e) { console.warn(`[passwords] ${table}:`, e.message) }
  }
  return total
}

// Arranca a los 30 s (deja que el servidor termine de levantar) y sigue por tandas
// mientras queden filas por convertir.
function start() {
  setTimeout(async function pass() {
    let n = 0
    try { n = await run() } catch (e) { console.warn('[passwords]', e.message); return }
    if (n >= BATCH) setTimeout(pass, PAUSE_MS)
    else if (n) console.log('[passwords] migración terminada: ya no quedan contraseñas en texto plano')
  }, 30000)
}

module.exports = { run, start }
