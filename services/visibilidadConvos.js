'use strict'
/**
 * Quién puede ver qué conversación.
 *
 * El permiso `soloAsignadas` de un rol limita el inbox de ese miembro a los chats asignados a
 * él o a un equipo suyo. Es una RESTRICCIÓN, no una concesión: quien no la tiene sigue viendo
 * todo, como hasta ahora.
 *
 * La regla vive aquí y no repartida por los controladores porque se aplica en cuatro sitios —la
 * lista, el chat suelto, las escrituras y el reparto por socket— y basta con que uno se quede
 * atrás para que el permiso no valga nada.
 *
 * Aviso sobre el alcance: hasta ahora el acceso por agente (`agentAccess`) solo se aplicaba en
 * el navegador, así que este es el primer permiso que restringe de verdad en el servidor.
 */
const pool = require('../db')

const TTL_CACHE_MS = 30 * 1000

/** ¿A esta sesión se le aplica la restricción? */
function estaRestringido(user) {
  if (!user || user.type !== 'member') return false
  return !!user.permissions?.soloAsignadas
}

/**
 * Los equipos a los que pertenece un miembro.
 *
 * Se leen todos los de la cuenta y se filtran en JS a propósito. `member_ids` es una columna
 * JSON, y `db.js` no fija `typeCast`: mysql2 la devuelve YA PARSEADA. Pasar ese array como
 * parámetro de un `?` lo expande en una lista separada por comas —el origen del «Column count
 * doesn't match value count» que ya costó un rato en el entorno de pruebas—, así que ni
 * `JSON_CONTAINS` con el array ni nada parecido.
 */
async function equiposDe(accId, memberId) {
  if (!memberId) return []
  const [filas] = await pool.query('SELECT id, member_ids FROM teams WHERE account_id=?', [accId])
  const salida = []
  for (const f of filas || []) {
    let ids = f.member_ids
    if (typeof ids === 'string') { try { ids = JSON.parse(ids) } catch { ids = [] } }
    if (Array.isArray(ids) && ids.some(x => String(x) === String(memberId))) salida.push(f.id)
  }
  return salida
}

/** El id del asesor asignado, venga como objeto o como cadena suelta. */
function idAsignado(asignado) {
  if (!asignado) return null
  if (typeof asignado === 'string') { try { asignado = JSON.parse(asignado) } catch { return asignado } }
  if (typeof asignado === 'string') return asignado
  return asignado?.id || null
}

/**
 * ¿Puede este miembro ver esta conversación?
 *
 * `conv` vale tanto la fila cruda (assigned_to/team_id) como el objeto ya mapeado
 * (assignedTo/teamId): la comprueban sitios distintos y obligar a normalizar antes solo
 * aumentaba las probabilidades de que alguno se olvidara.
 */
function puedeVer(conv, user, equipos = []) {
  if (!estaRestringido(user)) return true
  if (!conv) return false
  const asignado = idAsignado(conv.assigned_to !== undefined ? conv.assigned_to : conv.assignedTo)
  if (asignado && String(asignado) === String(user.id)) return true
  const equipo = conv.team_id !== undefined ? conv.team_id : conv.teamId
  return !!equipo && equipos.some(e => String(e) === String(equipo))
}

/** Filtra una lista. Si la sesión no está restringida, la devuelve tal cual. */
async function filtrar(convs, user, accId) {
  if (!estaRestringido(user)) return convs
  const equipos = await equiposDe(accId, user.id)
  return (convs || []).filter(c => puedeVer(c, user, equipos))
}

// ── Miembros restringidos de una cuenta (para el reparto por socket) ──────────

const _cache = new Map()   // accId → { ids: Set, hasta: number }

/**
 * Los ids de los miembros de la cuenta cuyo rol tiene la restricción.
 *
 * Se cachea con un TTL corto porque `socket.emit` corre en CADA mensaje. Lo importante es el
 * caso normal: una cuenta sin miembros restringidos devuelve un conjunto vacío y el emisor no
 * hace ningún trabajo extra.
 */
async function miembrosRestringidos(accId) {
  const guardado = _cache.get(accId)
  if (guardado && guardado.hasta > Date.now()) return guardado.ids

  const ids = new Set()
  try {
    const [filas] = await pool.query(
      `SELECT m.id, r.permissions
         FROM members m JOIN roles r ON m.role_id = r.id
        WHERE m.account_id=? AND m.status='active'`,
      [accId]
    )
    for (const f of filas || []) {
      let permisos = f.permissions
      if (typeof permisos === 'string') { try { permisos = JSON.parse(permisos) } catch { permisos = {} } }
      if (permisos?.soloAsignadas) ids.add(f.id)
    }
  } catch (e) {
    // Si la consulta falla se devuelve vacío: el efecto es que nadie recibe de más por la vía
    // de los restringidos, no que se filtre información.
    console.warn('[visibilidadConvos]', e.message)
  }
  _cache.set(accId, { ids, hasta: Date.now() + TTL_CACHE_MS })
  return ids
}

/** Olvida la caché de una cuenta (al cambiar roles o miembros). */
function olvidarCache(accId) {
  if (accId) _cache.delete(accId)
  else _cache.clear()
}

/**
 * De los miembros restringidos de la cuenta, los que SÍ pueden ver esta conversación.
 * Devuelve [] cuando no hay ninguno restringido, que es el caso normal.
 */
async function destinatariosRestringidos(accId, convId) {
  const restringidos = await miembrosRestringidos(accId)
  if (!restringidos.size || !convId) return []
  try {
    const [[conv]] = await pool.query('SELECT assigned_to, team_id FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!conv) return []
    const asignado = idAsignado(conv.assigned_to)

    // Los miembros del equipo se leen UNA vez, no una por miembro restringido: esto corre en
    // cada mensaje que sale, y una consulta por persona se nota en cuentas con equipo grande.
    let delEquipo = null
    if (conv.team_id) {
      const [equipos] = await pool.query('SELECT member_ids FROM teams WHERE id=? AND account_id=?', [conv.team_id, accId])
      let ids = equipos?.[0]?.member_ids
      if (typeof ids === 'string') { try { ids = JSON.parse(ids) } catch { ids = [] } }
      delEquipo = new Set((Array.isArray(ids) ? ids : []).map(String))
    }

    const salida = []
    for (const id of restringidos) {
      if (asignado && String(asignado) === String(id)) salida.push(id)
      else if (delEquipo?.has(String(id))) salida.push(id)
    }
    return salida
  } catch (e) {
    console.warn('[visibilidadConvos]', e.message)
    return []
  }
}

module.exports = {
  estaRestringido, equiposDe, puedeVer, filtrar, idAsignado,
  miembrosRestringidos, destinatariosRestringidos, olvidarCache,
}
