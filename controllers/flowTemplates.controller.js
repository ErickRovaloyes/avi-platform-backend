'use strict'
/**
 * Plantillas de flujos — biblioteca GLOBAL. El super admin las crea "publicando" un flujo
 * existente; cualquier dueño de cuenta las instala (clona) en su cuenta desde la pestaña
 * Flujos. Se reutiliza la tabla `flows` para el flujo instalado.
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')

// Un super admin que ENTRA a una cuenta recibe un token con type:'member' e
// isImpersonating:true (auth.controller.impersonate). Comprobar solo el tipo dejaba la
// publicación de plantillas fuera del alcance de todos, incluido él.
const isSuperAdmin = req => req.user?.type === 'superadmin' || req.user?.isImpersonating === true

// Remapea recursivamente cualquier id de nodo (strings dentro de connections) a ids nuevos.
function remapRefs(val, idMap) {
  if (typeof val === 'string') return idMap[val] || val
  if (Array.isArray(val)) return val.map(v => remapRefs(v, idMap))
  if (val && typeof val === 'object') { const o = {}; for (const [k, v] of Object.entries(val)) o[k] = remapRefs(v, idMap); return o }
  return val
}
// Clona el grafo con ids de nodo frescos (y remapea start_node_id + connections).
function cloneGraph(nodes, startNodeId) {
  const arr = Array.isArray(nodes) ? nodes : []
  const idMap = {}
  for (const n of arr) if (n?.id) idMap[n.id] = 'n_' + uid()
  const newNodes = arr.map(n => ({ ...n, id: idMap[n.id] || ('n_' + uid()), connections: remapRefs(n.connections || {}, idMap) }))
  return { nodes: newNodes, startNodeId: idMap[startNodeId] || (newNodes[0]?.id || null) }
}

// Biblioteca (cualquier miembro autenticado la ve para instalar).
const list = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id,name,description,category,`trigger`,nodes,created_at FROM flow_templates ORDER BY category, name')
    res.json(rows.map(r => ({
      id: r.id, name: r.name, description: r.description || '', category: r.category || '',
      trigger: r.trigger || 'manual', nodeCount: (parseJ(r.nodes, []) || []).length, createdAt: r.created_at,
    })))
  } catch (err) { console.error('[flow-templates list]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Crear plantilla desde un flujo (solo super admin). El front envía el grafo del flujo.
const create = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Solo super admin' })
  const b = req.body || {}
  const name = String(b.name || '').trim()
  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' })
  const nodes = Array.isArray(b.nodes) ? b.nodes : []
  if (!nodes.length) return res.status(400).json({ error: 'La plantilla no tiene nodos' })
  const id = 'ftpl_' + uid(); const now = Date.now()
  try {
    await pool.query(
      'INSERT INTO flow_templates (id,name,description,category,`trigger`,start_node_id,nodes,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, name.slice(0, 150), String(b.description || '').slice(0, 2000), String(b.category || '').slice(0, 60),
       b.trigger || 'manual', b.startNodeId || null, JSON.stringify(nodes), req.user?.name || 'Super Admin', now, now]
    )
    res.json({ id })
  } catch (err) { console.error('[flow-templates create]', err); res.status(500).json({ error: 'Error interno' }) }
}

const update = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Solo super admin' })
  const { id } = req.params; const b = req.body || {}
  const sets = [], vals = []
  if (b.name        !== undefined) { sets.push('name=?');        vals.push(String(b.name).slice(0, 150)) }
  if (b.description !== undefined) { sets.push('description=?'); vals.push(String(b.description).slice(0, 2000)) }
  if (b.category    !== undefined) { sets.push('category=?');    vals.push(String(b.category).slice(0, 60)) }
  if (!sets.length) return res.json({ ok: true })
  sets.push('updated_at=?'); vals.push(Date.now(), id)
  try { await pool.query(`UPDATE flow_templates SET ${sets.join(',')} WHERE id=?`, vals); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Solo super admin' })
  try { await pool.query('DELETE FROM flow_templates WHERE id=?', [req.params.id]); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Instalar una plantilla en una cuenta (clona el grafo en un flujo nuevo).
const install = async (req, res) => {
  const { accId, templateId } = req.params
  if (req.user?.type !== 'superadmin' && req.user?.accountId !== accId) return res.status(403).json({ error: 'No autorizado' })
  try {
    const [[t]] = await pool.query('SELECT * FROM flow_templates WHERE id=?', [templateId])
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' })
    const { nodes, startNodeId } = cloneGraph(parseJ(t.nodes, []), t.start_node_id)
    const flowId = 'flow_' + uid()
    await pool.query(
      'INSERT INTO flows (id,account_id,name,`trigger`,start_node_id,nodes,created_at) VALUES (?,?,?,?,?,?,?)',
      [flowId, accId, t.name, t.trigger || 'manual', startNodeId, JSON.stringify(nodes), Date.now()]
    )
    try { require('../services/socket').emit(accId, 'account:updated', { accId }) } catch {}
    res.json({ id: flowId, name: t.name })
  } catch (err) { console.error('[flow-templates install]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, update, remove, install }
