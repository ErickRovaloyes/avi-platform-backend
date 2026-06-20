'use strict'
const pool = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')
const campaigns = require('../services/campaigns')

const mapCampaign = c => ({
  id: c.id, agentId: c.agent_id, name: c.name, channel: c.channel,
  flowId: c.flow_id, audience: parseJ(c.audience, {}),
  scheduledAt: c.scheduled_at, status: c.status, stats: parseJ(c.stats, null),
  sentAt: c.sent_at, createdAt: c.created_at,
})

const list = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM campaigns WHERE account_id=? ORDER BY created_at DESC', [accId])
    res.json(rows.map(mapCampaign))
  } catch (err) { console.error('[campaigns list]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Vista previa del tamaño de la audiencia para un filtro dado.
const preview = async (req, res) => {
  const { accId } = req.params
  try { res.json({ count: await campaigns.audienceCount(accId, req.body?.audience || {}) }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const { name, agentId, flowId, channel = 'whatsapp', audience = {}, scheduledAt = null } = req.body || {}
  if (!name || !flowId || !agentId) return res.status(400).json({ error: 'Nombre, agente y flujo son obligatorios' })
  const id = 'camp_' + uid()
  const status = scheduledAt ? 'scheduled' : 'draft'
  try {
    await pool.query(
      'INSERT INTO campaigns (id,account_id,agent_id,name,channel,flow_id,audience,scheduled_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, accId, agentId, name, channel, flowId, JSON.stringify(audience || {}), scheduledAt || null, status, Date.now()]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id, status })
  } catch (err) { console.error('[campaigns create]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Enviar ya (no bloquea: corre en segundo plano).
const sendNow = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[c]] = await pool.query('SELECT status FROM campaigns WHERE id=? AND account_id=?', [id, accId])
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' })
    if (['sending', 'done'].includes(c.status)) return res.status(409).json({ error: 'La campaña ya se está enviando o ya terminó' })
    campaigns.runCampaign(id).then(() => socket.emit(accId, 'account:updated', { accId })).catch(e => console.warn('[sendNow]', e.message))
    res.json({ ok: true, started: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const cancel = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query("UPDATE campaigns SET status='cancelled' WHERE id=? AND account_id=? AND status IN ('draft','scheduled')", [id, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query('DELETE FROM campaigns WHERE id=? AND account_id=?', [id, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, preview, create, sendNow, cancel, remove }
