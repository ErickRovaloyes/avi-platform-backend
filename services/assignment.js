'use strict'
/**
 * Reparto de trabajo entre asesores (round-robin o a todos a la vez).
 *
 * Fuente del grupo de asesores, en este orden:
 *   modo 'equipo' → los miembros del equipo elegido (teams.member_ids)
 *   modo 'lista'  → los miembros marcados a mano
 *   modo 'fijo'   → un único asesor (comportamiento clásico)
 *
 * El turno del round-robin se guarda por "ámbito" (assignment_counters), de modo que cada
 * nodo de flujo o calendario lleva su propia rotación y no interfiere con los demás.
 * Se ignoran los miembros inactivos para no asignarle trabajo a alguien dado de baja.
 */
const pool = require('../db')
const { parseJ } = require('../utils')

// Siguiente índice de la rotación para un ámbito (p. ej. `transfer:<flowId>:<nodeId>`).
// Un UPSERT atómico evita que dos conversaciones simultáneas caigan en el mismo asesor.
async function nextTurn(accId, scope, size) {
  if (size <= 1) return 0
  try {
    await pool.query(
      `INSERT INTO assignment_counters (account_id, scope, turn, updated_at) VALUES (?,?,1,?)
       ON DUPLICATE KEY UPDATE turn = turn + 1, updated_at = VALUES(updated_at)`,
      [accId, scope, Date.now()]
    )
    const [[r]] = await pool.query('SELECT turn FROM assignment_counters WHERE account_id=? AND scope=?', [accId, scope])
    const turn = Number(r?.turn) || 1
    return (turn - 1) % size
  } catch {
    // Sin la tabla (migración pendiente) se reparte al azar antes que fallar la transferencia.
    return Math.floor(Math.random() * size)
  }
}

// Resuelve el grupo de asesores candidatos a partir de la config del nodo/calendario.
// `members` = lista del account público [{ id, name, status }].
async function resolvePool(accId, cfg = {}, members = []) {
  const activos = (members || []).filter(m => m?.id && m.status !== 'inactive')
  const byId = id => activos.find(m => m.id === id) || null
  const modo = cfg.modo || (cfg.asignar_a ? 'fijo' : 'ninguno')

  if (modo === 'fijo') { const m = byId(cfg.asignar_a); return m ? [m] : [] }

  if (modo === 'equipo' && cfg.equipoId) {
    try {
      const [[t]] = await pool.query('SELECT member_ids FROM teams WHERE id=? AND account_id=?', [cfg.equipoId, accId])
      const ids = parseJ(t?.member_ids, [])
      return ids.map(byId).filter(Boolean)
    } catch { return [] }
  }

  if (modo === 'lista' && Array.isArray(cfg.miembros)) {
    return cfg.miembros.map(byId).filter(Boolean)
  }
  return []
}

/**
 * Elige a quién asignar. Devuelve { assignees: [{id,name}], all: bool }.
 *   reparto 'todos'       → devuelve todo el grupo (se avisa a todos).
 *   reparto 'round_robin' → devuelve UN asesor, rotando el turno.
 */
async function pickAssignees(accId, cfg = {}, members = [], scope = 'default') {
  const pool_ = await resolvePool(accId, cfg, members)
  if (!pool_.length) return { assignees: [], all: false }
  const lean = pool_.map(m => ({ id: m.id, name: m.name }))
  if (pool_.length === 1) return { assignees: lean, all: false }
  if (cfg.reparto === 'todos') return { assignees: lean, all: true }
  const i = await nextTurn(accId, scope, lean.length)
  return { assignees: [lean[i]], all: false }
}

module.exports = { pickAssignees, resolvePool, nextTurn }
