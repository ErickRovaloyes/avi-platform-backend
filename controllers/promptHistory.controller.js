'use strict'
const pool = require('../db')
const { createBackupInternal } = require('./backups.controller')

// POST /api/accounts/:accId/prompt-history
// Body: { agentId, promptId, promptName, instruction, category, wasEditedManually,
//         oldContent, newContent, inputTokens, outputTokens, totalTokens, costUsd,
//         model, provider }
const createEntry = async (req, res) => {
  const { accId } = req.params
  const {
    agentId, promptId, promptName,
    instruction = '', category = 'medium',
    wasEditedManually = false,
    oldContent = '', newContent = '',
    inputTokens = 0, outputTokens = 0, totalTokens = 0, costUsd = 0,
    model = '', provider = '',
  } = req.body || {}

  try {
    // 1) Snapshot the current state as a flash backup BEFORE the change is applied.
    //    The Change Agent applies the new prompt right after this, so the flash backup
    //    captures the previous state precisely.
    let backupId = null
    try {
      const bk = await createBackupInternal({
        accId, agId: agentId,
        label: `⚡ Antes de "${(instruction || 'cambio').slice(0, 60)}"`,
        type: 'flash',
      })
      backupId = bk.id
    } catch (e) {
      console.warn('[history] flash backup failed:', e.message)
    }

    // 2) Persist the history entry
    const userName = req.user?.name || req.user?.email || 'desconocido'
    const userId   = req.user?.id || null
    const ts = Date.now()

    const [r] = await pool.query(
      `INSERT INTO prompt_change_history
         (account_id, agent_id, prompt_id, prompt_name, user_id, user_name,
          instruction, category, was_edited_manually,
          old_content, new_content,
          input_tokens, output_tokens, total_tokens, cost_usd,
          model, provider, backup_id, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        accId, agentId || null, promptId || null, promptName || null,
        userId, userName,
        instruction, category, wasEditedManually ? 1 : 0,
        String(oldContent || ''), String(newContent || ''),
        parseInt(inputTokens)  || 0,
        parseInt(outputTokens) || 0,
        parseInt(totalTokens)  || 0,
        Number(costUsd)        || 0,
        model, provider, backupId, ts,
      ]
    )
    res.json({ id: r.insertId, ts, backupId })
  } catch (err) {
    console.error('[POST HISTORY]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

// GET /api/accounts/:accId/prompt-history?agentId=&limit=&offset=
const listEntries = async (req, res) => {
  const { accId } = req.params
  const { agentId, limit = 50, offset = 0 } = req.query
  try {
    const where = ['account_id=?']
    const params = [accId]
    if (agentId) { where.push('agent_id=?'); params.push(agentId) }
    const [rows] = await pool.query(
      `SELECT * FROM prompt_change_history WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      [...params, Math.min(parseInt(limit) || 50, 200), parseInt(offset) || 0]
    )
    res.json(rows.map(r => ({
      id: r.id,
      agentId: r.agent_id, promptId: r.prompt_id, promptName: r.prompt_name,
      userId: r.user_id, userName: r.user_name,
      instruction: r.instruction, category: r.category,
      wasEditedManually: !!r.was_edited_manually,
      oldContent: r.old_content, newContent: r.new_content,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, totalTokens: r.total_tokens,
      costUsd: Number(r.cost_usd),
      model: r.model, provider: r.provider,
      backupId: r.backup_id,
      ts: r.ts,
    })))
  } catch (err) {
    console.error('[LIST HISTORY]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// GET /api/accounts/:accId/prompt-history/:id — fetch full single entry
const getEntry = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[r]] = await pool.query('SELECT * FROM prompt_change_history WHERE id=? AND account_id=?', [id, accId])
    if (!r) return res.status(404).json({ error: 'No encontrado' })
    res.json({
      id: r.id,
      agentId: r.agent_id, promptId: r.prompt_id, promptName: r.prompt_name,
      userId: r.user_id, userName: r.user_name,
      instruction: r.instruction, category: r.category,
      wasEditedManually: !!r.was_edited_manually,
      oldContent: r.old_content, newContent: r.new_content,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, totalTokens: r.total_tokens,
      costUsd: Number(r.cost_usd),
      model: r.model, provider: r.provider,
      backupId: r.backup_id,
      ts: r.ts,
    })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { createEntry, listEntries, getEntry }
