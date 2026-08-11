'use strict'
/**
 * Borrado de la PROPIA cuenta por su dueño.
 *
 * Es la acción más destructiva de la plataforma: se lleva por delante conversaciones,
 * contactos, flujos, pedidos y todo lo demás, y no se puede deshacer. Por eso va en dos
 * pasos y con un código enviado al correo de la cuenta:
 *
 *   1) POST /api/accounts/:accId/delete/request   → envía un código de 6 dígitos
 *   2) POST /api/accounts/:accId/delete/confirm   → { code } y se borra
 *
 * El código se manda SIEMPRE al correo registrado de la cuenta, nunca a uno que venga en la
 * petición: si no, cualquiera con la sesión abierta podría desviar la confirmación a un
 * correo suyo. Reutiliza services/verifyCodes.js, que ya gestiona expiración (10 min),
 * un solo uso e intentos limitados.
 */
const pool = require('../db')
const { issueCode, verifyCode } = require('../services/verifyCodes')

const PURPOSE = 'delete_account'

/**
 * Quién puede borrar: solo el DUEÑO de esa cuenta.
 *
 * Se excluye explícitamente al super admin en modo vista (`isImpersonating`): entra con
 * `role_owner` para poder trabajar, así que sin esta comprobación podría borrar la cuenta de
 * un cliente desde el panel de ese cliente, por accidente y sin dejar rastro de quién fue.
 * El super admin tiene su propia vía, en su panel.
 */
function puedeBorrar(user, accId) {
  if (!user) return 'No hay sesión.'
  if (user.isImpersonating) return 'Estás viendo esta cuenta como super admin. El borrado debe hacerlo su dueño, o hacerse desde el Super Panel.'
  if (user.type !== 'member') return 'Solo el dueño de la cuenta puede borrarla.'
  if (String(user.accountId) !== String(accId)) return 'Esta cuenta no es la tuya.'
  if (user.roleId !== 'role_owner') return 'Solo el dueño de la cuenta puede borrarla. Pídeselo a quien la administra.'
  return null
}

// Paso 1: enviar el código al correo de la cuenta.
const requestDelete = async (req, res) => {
  const { accId } = req.params
  const motivo = puedeBorrar(req.user, accId)
  if (motivo) return res.status(403).json({ error: motivo })
  try {
    const [[acc]] = await pool.query('SELECT id, name, email FROM accounts WHERE id=?', [accId])
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' })
    const destino = (acc.email || '').trim()
    if (!destino) return res.status(400).json({ error: 'La cuenta no tiene un correo registrado al que enviar el código. Añádelo antes en los datos de la cuenta.' })

    const r = await issueCode(destino, PURPOSE)
    if (!r.ok) return res.status(400).json({ error: r.error || 'No se pudo enviar el código.' })

    // El correo se devuelve ENMASCARADO: confirma a dónde fue sin exponerlo entero.
    const [u, dom] = destino.split('@')
    const masked = `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${dom || ''}`
    res.json({ ok: true, sentTo: masked })
  } catch (err) {
    console.error('[delete account request]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// Paso 2: comprobar el código y borrar.
const confirmDelete = async (req, res) => {
  const { accId } = req.params
  const motivo = puedeBorrar(req.user, accId)
  if (motivo) return res.status(403).json({ error: motivo })
  const code = String(req.body?.code || '').trim()
  if (!code) return res.status(400).json({ error: 'Falta el código de confirmación.' })
  try {
    const [[acc]] = await pool.query('SELECT id, name, email FROM accounts WHERE id=?', [accId])
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' })

    const v = await verifyCode((acc.email || '').trim(), PURPOSE, code)
    if (!v.ok) return res.status(400).json({ error: v.error || 'Código incorrecto o caducado.' })

    // Queda constancia ANTES de borrar: después no habría de dónde sacarlo.
    console.warn(`[cuenta borrada] ${acc.id} "${acc.name}" <${acc.email}> por ${req.user?.email || req.user?.id}`)

    // Se lleva TODO lo que cuelga de la cuenta. Un `DELETE FROM accounts` a secas dejaría
    // conversaciones, mensajes y contactos huérfanos: el esquema no tiene ni una clave
    // foránea en cascada.
    const r = await require('../services/accountPurge').purgeAccount(accId)
    if (r.errores.length) console.warn('[cuenta borrada] tablas con incidencias:', r.errores.join(' · '))
    console.warn(`[cuenta borrada] ${acc.id}: ${r.filas} filas en ${r.tablas} tablas`)
    res.json({ ok: true, deletedRows: r.filas })
  } catch (err) {
    console.error('[delete account confirm]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = { requestDelete, confirmDelete }
