'use strict'
/**
 * Contraseñas: hash y verificación.
 *
 * Hasta ahora se guardaban EN TEXTO PLANO y se comparaban con `=` dentro del SQL, así que
 * cualquiera con acceso a la base de datos (una copia de seguridad, un volcado, un
 * empleado, una inyección) veía todas las contraseñas de todos los usuarios de todas las
 * cuentas — y, como la gente reutiliza contraseñas, también las de sus correos y bancos.
 *
 * Se usa bcrypt (bcryptjs, JS puro: no necesita compilarse en el servidor y ya estaba en
 * las dependencias). Un hash bcrypt son 60 caracteres, así que cabe en el VARCHAR(100) que
 * ya tienen las columnas: no hace falta migrar el esquema.
 *
 * La transición es tolerante a propósito: `verify` acepta las filas que todavía estén en
 * texto plano y avisa con `legacy:true` para que quien llama las convierta en ese momento.
 * Sin eso, el día del despliegue nadie podría entrar hasta que terminara la migración.
 */
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

// 10 rondas: el estándar de bcrypt y el mínimo que recomienda OWASP. Con bcryptjs (JS puro)
// son ~100 ms por verificación; subir a 12 lo llevaría a ~400 ms y se notaría en cada login.
const ROUNDS = 10
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/

/** ¿El valor guardado ya es un hash bcrypt (y no una contraseña en claro)? */
function isHash(value) { return BCRYPT_RE.test(String(value || '')) }

/** Hashea una contraseña en claro. */
async function hash(plain) { return bcrypt.hash(String(plain), ROUNDS) }

/**
 * Valor listo para guardar en la columna `password`.
 *
 * Si lo que llega YA es un hash se devuelve tal cual: hay dos sitios que copian la
 * contraseña de otra fila del mismo usuario (invitaciones y alta del dueño en una cuenta
 * nueva), y volver a hashear un hash dejaría a esa persona sin poder entrar.
 * Cadena vacía → cadena vacía: es "sin contraseña", no la contraseña "".
 */
async function toStored(value) {
  const s = String(value ?? '')
  if (!s) return ''
  return isHash(s) ? s : hash(s)
}

/**
 * Verifica una contraseña contra lo guardado.
 * Devuelve `{ ok, legacy }` — `legacy:true` significa que la fila seguía en texto plano y
 * quien llama debería re-guardarla hasheada.
 */
async function verify(plain, stored) {
  const s = String(stored ?? '')
  const p = String(plain ?? '')
  if (!s || !p) return { ok: false, legacy: false }
  if (isHash(s)) return { ok: await bcrypt.compare(p, s), legacy: false }
  // Fila heredada en texto plano. Comparación en tiempo constante para no filtrar por
  // tiempo cuántos caracteres coinciden; la longitud sí se filtra, pero esto es temporal
  // y desaparece en cuanto la migración de arranque termina.
  const a = Buffer.from(p, 'utf8'), b = Buffer.from(s, 'utf8')
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
  return { ok, legacy: true }
}

module.exports = { hash, toStored, verify, isHash, ROUNDS }
