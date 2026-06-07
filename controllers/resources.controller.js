'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// ── Variables ─────────────────────────────────────────────────────────────────

const createVariable = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, type = 'local', defaultValue = '', description = '', isSystem = false } = req.body
  const id = gId || ('var_' + uid())
  try {
    await pool.query('INSERT INTO variables (id,account_id,name,type,default_value,description,is_system) VALUES (?,?,?,?,?,?,?)', [id, accId, name, type, defaultValue, description, isSystem ? 1 : 0])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateVariable = async (req, res) => {
  const { accId, varId } = req.params
  const { name, type, defaultValue, description } = req.body
  try {
    const sets = []; const vals = []
    if (name         !== undefined) { sets.push('name=?');          vals.push(name) }
    if (type         !== undefined) { sets.push('type=?');          vals.push(type) }
    if (defaultValue !== undefined) { sets.push('default_value=?'); vals.push(defaultValue) }
    if (description  !== undefined) { sets.push('description=?');   vals.push(description) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(varId, accId)
    await pool.query(`UPDATE variables SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteVariable = async (req, res) => {
  const { accId, varId } = req.params
  try {
    await pool.query('DELETE FROM variables WHERE id=? AND account_id=?', [varId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── AI Tools ──────────────────────────────────────────────────────────────────

const createAITool = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, description, collectFields = [], flowId = null, actionType = 'variable', n8nIntegrationId = null } = req.body
  const id = gId || ('tool_' + uid())
  try {
    await pool.query(
      'INSERT INTO ai_tools (id,account_id,name,description,collect_fields,flow_id,action_type,n8n_integration_id) VALUES (?,?,?,?,?,?,?,?)',
      [id, accId, name, description, JSON.stringify(collectFields), flowId, actionType, n8nIntegrationId]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { console.error('[createAITool]', err); res.status(500).json({ error: 'Error interno' }) }
}

const updateAITool = async (req, res) => {
  const { accId, toolId } = req.params
  const { name, description, collectFields, flowId, actionType, n8nIntegrationId } = req.body
  try {
    const sets = []; const vals = []
    if (name             !== undefined) { sets.push('name=?');               vals.push(name) }
    if (description      !== undefined) { sets.push('description=?');        vals.push(description) }
    if (collectFields    !== undefined) { sets.push('collect_fields=?');     vals.push(JSON.stringify(collectFields)) }
    if (flowId           !== undefined) { sets.push('flow_id=?');            vals.push(flowId) }
    if (actionType       !== undefined) { sets.push('action_type=?');        vals.push(actionType) }
    if (n8nIntegrationId !== undefined) { sets.push('n8n_integration_id=?'); vals.push(n8nIntegrationId) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(toolId, accId)
    await pool.query(`UPDATE ai_tools SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteAITool = async (req, res) => {
  const { accId, toolId } = req.params
  try {
    await pool.query('DELETE FROM ai_tools WHERE id=? AND account_id=?', [toolId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Flows ─────────────────────────────────────────────────────────────────────

const createFlow = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, trigger, startNodeId = null, nodes = [] } = req.body
  const id = gId || ('flow_' + uid())
  try {
    await pool.query('INSERT INTO flows (id,account_id,name,`trigger`,start_node_id,nodes) VALUES (?,?,?,?,?,?)', [id, accId, name, trigger, startNodeId, JSON.stringify(nodes)])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateFlow = async (req, res) => {
  const { accId, flowId } = req.params
  const { name, trigger, startNodeId, nodes } = req.body
  try {
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');          vals.push(name) }
    if (trigger     !== undefined) { sets.push('`trigger`=?');     vals.push(trigger) }
    if (startNodeId !== undefined) { sets.push('start_node_id=?'); vals.push(startNodeId) }
    if (nodes       !== undefined) { sets.push('nodes=?');         vals.push(JSON.stringify(nodes)) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(flowId, accId)
    await pool.query(`UPDATE flows SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteFlow = async (req, res) => {
  const { accId, flowId } = req.params
  try {
    await pool.query('DELETE FROM flows WHERE id=? AND account_id=?', [flowId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = {
  createVariable, updateVariable, deleteVariable,
  createAITool, updateAITool, deleteAITool,
  createFlow, updateFlow, deleteFlow,
}
