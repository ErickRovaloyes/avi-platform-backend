'use strict'
/**
 * Freno a la fuerza bruta en el login: 3 intentos fallidos → 12 horas sin poder entrar.
 *
 * Hashear la contraseña protege lo GUARDADO; esto protege el FORMULARIO. Sin ello se pueden
 * probar contraseñas contra /api/auth/login sin ningún límite, que es la vía más barata para
 * entrar en una cuenta.
 *
 * Se cuenta por CORREO (no por IP): un atacante cambia de IP con facilidad, así que contar
 * por IP no frena casi nada. El efecto secundario conocido de contar por correo es que
 * cualquiera que sepa tu correo puede dejarte fuera 12 h fallando aposta — por eso el
 * bloqueo se levanta al completar «olvidé mi contraseña»: quien recibe el código en SU
 * buzón demuestra que es el dueño, y así nadie se queda tirado por culpa de un tercero.
 */
const pool = require('../db')

const MAX_FAILS = 3
const LOCK_MS = 12 * 60 * 60 * 1000

const norm = email => String(email || '').trim().toLowerCase()

/**
 * ¿Está bloqueado? Devuelve `{ locked, until, minutes }`.
 * Ante un error de base de datos NO bloquea: preferimos dejar entrar a alguien legítimo
 * antes que dejar a todo el mundo fuera por un fallo de infraestructura.
 */
async function check(email) {
  const e = norm(email)
  if (!e) return { locked: false }
  try {
    const [[r]] = await pool.query('SELECT fails, locked_until FROM login_attempts WHERE email=?', [e])
    const until = Number(r?.locked_until) || 0
    if (until > Date.now()) {
      return { locked: true, until, minutes: Math.ceil((until - Date.now()) / 60000) }
    }
    return { locked: false }
  } catch { return { locked: false } }
}

/** Suma un fallo. Al llegar a 3, bloquea 12 h. Devuelve `{ fails, locked, minutes }`. */
async function fail(email) {
  const e = norm(email)
  if (!e) return { fails: 0, locked: false }
  const now = Date.now()
  try {
    // Si ya había un bloqueo VENCIDO, esta misma sentencia lo reinicia a 1: `fails+1` parte
    // del contador viejo, así que se limpia antes cuando el bloqueo expiró.
    const [[r]] = await pool.query('SELECT fails, locked_until FROM login_attempts WHERE email=?', [e])
    const expired = r && Number(r.locked_until) && Number(r.locked_until) <= now
    const fails = (expired || !r) ? 1 : Number(r.fails || 0) + 1
    const lockedUntil = fails >= MAX_FAILS ? now + LOCK_MS : 0
    await pool.query(
      `INSERT INTO login_attempts (email, fails, locked_until, updated_at) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE fails=VALUES(fails), locked_until=VALUES(locked_until), updated_at=VALUES(updated_at)`,
      [e, fails, lockedUntil, now]
    )
    return { fails, locked: !!lockedUntil, minutes: lockedUntil ? Math.ceil(LOCK_MS / 60000) : 0 }
  } catch { return { fails: 0, locked: false } }
}

/** Borra el contador. Se llama al entrar bien y al completar el cambio de contraseña. */
async function clear(email) {
  const e = norm(email)
  if (!e) return
  try { await pool.query('DELETE FROM login_attempts WHERE email=?', [e]) } catch {}
}

/** Mensaje para el usuario. No revela si el correo existe; sí ofrece la salida. */
function lockedMessage(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60
  const falta = h > 0 ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
  return `Demasiados intentos fallidos. Vuelve a intentarlo en ${falta}, o usa «¿Olvidaste tu contraseña?» para recuperar el acceso ahora mismo.`
}

module.exports = { check, fail, clear, lockedMessage, MAX_FAILS, LOCK_MS }
