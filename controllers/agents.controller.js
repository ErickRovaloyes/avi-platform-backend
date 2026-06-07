'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// ── Agents ────────────────────────────────────────────────────────────────────

const createAgent = async (req, res) => {
  const { accId } = req.params
  const { name, status = 'active', systemPrompt = '', model = 'gpt-4o-mini', welcomeMessage = '', prompts, channels, rag, aiToolIds } = req.body
  const id = 'ag_' + uid()
  try {
    await pool.query(
      'INSERT INTO agents (id,account_id,name,status,system_prompt,model,welcome_message,prompts,channels,rag,ai_tool_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, accId, name, status, systemPrompt, model, welcomeMessage,
       JSON.stringify(prompts || []), JSON.stringify(channels || []),
       JSON.stringify(rag || { enabled: false, files: [] }), JSON.stringify(aiToolIds || [])]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) {
    console.error('[POST AGENT]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const updateAgent = async (req, res) => {
  const { accId, agId } = req.params
  const { addToolId, removeToolId, ...rest } = req.body
  const map = { name:'name', status:'status', systemPrompt:'system_prompt', model:'model', welcomeMessage:'welcome_message', prompts:'prompts', channels:'channels', rag:'rag', aiToolIds:'ai_tool_ids', fallbackFlowId:'fallback_flow_id', testFlowId:'test_flow_id' }
  try {
    if (addToolId || removeToolId) {
      const [[ag]] = await pool.query('SELECT ai_tool_ids FROM agents WHERE id=? AND account_id=?', [agId, accId])
      if (!ag) return res.status(404).json({ error: 'Agente no encontrado' })
      let ids = parseJ(ag.ai_tool_ids, [])
      if (addToolId && !ids.includes(addToolId)) ids.push(addToolId)
      if (removeToolId) ids = ids.filter(t => t !== removeToolId)
      await pool.query('UPDATE agents SET ai_tool_ids=? WHERE id=?', [JSON.stringify(ids), agId])
      socket.emit(accId, 'account:updated', { accId })
      return res.json({ ok: true })
    }
    const sets = []; const vals = []
    for (const [key, col] of Object.entries(map)) {
      if (rest[key] !== undefined) {
        sets.push(`${col}=?`)
        vals.push(typeof rest[key] === 'object' ? JSON.stringify(rest[key]) : rest[key])
      }
    }
    if (!sets.length) return res.json({ ok: true })
    vals.push(agId, accId)
    await pool.query(`UPDATE agents SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Error interno' })
  }
}

const deleteAgent = async (req, res) => {
  const { accId, agId } = req.params
  try {
    await pool.query('DELETE FROM agents WHERE id=? AND account_id=?', [agId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Channels ──────────────────────────────────────────────────────────────────

const getChannels = async (req, res) => {
  const { accId, agId } = req.params
  try {
    const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
    res.json(ag ? parseJ(ag.channels, []) : [])
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createChannel = async (req, res) => {
  const { accId, agId } = req.params
  try {
    const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
    if (!ag) return res.status(404).json({ error: 'Agente no encontrado' })
    const channels = parseJ(ag.channels, [])
    const newCh = { id: 'ch_' + uid(), createdAt: Date.now(), ...req.body }
    channels.push(newCh)
    await pool.query('UPDATE agents SET channels=? WHERE id=?', [JSON.stringify(channels), agId])
    socket.emit(accId, 'account:updated', { accId })
    res.json(newCh)
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateChannel = async (req, res) => {
  const { accId, agId, channelId } = req.params
  try {
    const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
    if (!ag) return res.status(404).json({ error: 'Agente no encontrado' })
    const channels = parseJ(ag.channels, []).map(c => c.id === channelId ? { ...c, ...req.body } : c)
    await pool.query('UPDATE agents SET channels=? WHERE id=?', [JSON.stringify(channels), agId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteChannel = async (req, res) => {
  const { accId, agId, channelId } = req.params
  try {
    const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
    if (!ag) return res.status(404).json({ error: 'Agente no encontrado' })
    const channels = parseJ(ag.channels, []).filter(c => c.id !== channelId)
    await pool.query('UPDATE agents SET channels=? WHERE id=?', [JSON.stringify(channels), agId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const createPrompt = async (req, res) => {
  const { accId, agId } = req.params
  try {
    const [[ag]] = await pool.query('SELECT prompts FROM agents WHERE id=? AND account_id=?', [agId, accId])
    if (!ag) return res.status(404).json({ error: 'Agente no encontrado' })
    const prompts = parseJ(ag.prompts, [])
    const newPr = { id: 'pr_' + uid(), ...req.body }
    prompts.push(newPr)
    await pool.query('UPDATE agents SET prompts=? WHERE id=?', [JSON.stringify(prompts), agId])
    socket.emit(accId, 'account:updated', { accId })
    res.json(newPr)
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updatePrompt = async (req, res) => {
  const { accId, agId, promptId } = req.params
  try {
    const [[ag]] = await pool.query('SELECT prompts,system_prompt FROM agents WHERE id=? AND account_id=?', [agId, accId])
    if (!ag) return res.status(404).json({ error: 'Agente no encontrado' })
    let prompts = parseJ(ag.prompts, []).map(p => p.id === promptId ? { ...p, ...req.body } : p)
    const sets = ['prompts=?']; const vals = [JSON.stringify(prompts)]
    if (req.body.isActive) {
      prompts = prompts.map(p => ({ ...p, isActive: p.id === promptId }))
      vals[0] = JSON.stringify(prompts)
      const active = prompts.find(p => p.id === promptId)
      if (active?.content) { sets.push('system_prompt=?'); vals.push(active.content) }
    }
    vals.push(agId)
    await pool.query(`UPDATE agents SET ${sets.join(',')} WHERE id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deletePrompt = async (req, res) => {
  const { accId, agId, promptId } = req.params
  try {
    const [[ag]] = await pool.query('SELECT prompts FROM agents WHERE id=? AND account_id=?', [agId, accId])
    if (!ag) return res.status(404).json({ error: 'Agente no encontrado' })
    const prompts = parseJ(ag.prompts, []).filter(p => p.id !== promptId)
    await pool.query('UPDATE agents SET prompts=? WHERE id=?', [JSON.stringify(prompts), agId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = {
  createAgent, updateAgent, deleteAgent,
  getChannels, createChannel, updateChannel, deleteChannel,
  createPrompt, updatePrompt, deletePrompt,
}
