'use strict'
const pool = require('../db')

// GET /api/accounts/:accId/flow-executions?limit=&status=
const listExecutions = async (req, res) => {
  const { accId } = req.params
  const { limit = 200, status } = req.query
  try {
    const where = ['fe.account_id=?']; const params = [accId]
    if (status) { where.push('fe.status=?'); params.push(status) }
    const [rows] = await pool.query(
      `SELECT fe.id, fe.agent_id, fe.conv_id, fe.flow_id, fe.flow_name, fe.trigger_type,
              fe.status, fe.error, fe.duration_ms, fe.started_at, fe.source,
              c.guest_name, c.channel_type
       FROM flow_executions fe
       LEFT JOIN conversations c ON c.id = fe.conv_id
       WHERE ${where.join(' AND ')}
       ORDER BY fe.started_at DESC LIMIT ?`,
      [...params, Math.min(parseInt(limit) || 200, 1000)]
    )
    res.json(rows.map(r => ({
      id: r.id, agentId: r.agent_id, convId: r.conv_id, flowId: r.flow_id, flowName: r.flow_name,
      trigger: r.trigger_type, status: r.status, error: r.error, durationMs: r.duration_ms,
      startedAt: r.started_at, source: r.source,
      guestName: r.guest_name, channel: r.channel_type,
    })))
  } catch (err) { console.error('[flow-executions]', err); res.status(500).json({ error: 'Error interno' }) }
}

// GET /api/accounts/:accId/error-log?limit=
const listErrors = async (req, res) => {
  const { accId } = req.params
  const { limit = 200 } = req.query
  try {
    const [rows] = await pool.query(
      `SELECT el.id, el.agent_id, el.conv_id, el.source, el.message, el.detail, el.ts,
              c.guest_name, c.channel_type
       FROM error_log el
       LEFT JOIN conversations c ON c.id = el.conv_id
       WHERE el.account_id=?
       ORDER BY el.ts DESC LIMIT ?`,
      [accId, Math.min(parseInt(limit) || 200, 1000)]
    )
    res.json(rows.map(r => ({
      id: r.id, agentId: r.agent_id, convId: r.conv_id, source: r.source,
      message: r.message, detail: r.detail, ts: r.ts,
      guestName: r.guest_name, channel: r.channel_type,
    })))
  } catch (err) { console.error('[error-log]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { listExecutions, listErrors }
