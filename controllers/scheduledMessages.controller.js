'use strict'
const svc = require('../services/scheduledMessages')

const guard = (req, res) => {
  const { accId } = req.params
  if (req.user?.type !== 'superadmin' && req.user?.accountId !== accId) {
    res.status(403).json({ error: 'No autorizado' }); return false
  }
  return true
}

const list = async (req, res) => {
  if (!guard(req, res)) return
  try {
    res.json({ scheduled: await svc.list(req.params.accId, { convId: req.query.convId, status: req.query.status }) })
  } catch (err) { console.error('[scheduled list]', err); res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  if (!guard(req, res)) return
  const b = req.body || {}
  try {
    const row = await svc.create(req.params.accId, {
      agentId: b.agentId, convId: b.convId, content: b.content, scheduledAt: b.scheduledAt,
      createdBy: req.user?.id || null, createdByName: req.user?.name || req.user?.email || 'Asesor',
    })
    res.json({ scheduled: row })
  } catch (e) {
    // 409 cuando el problema es la ventana de servicio (el front lo distingue del resto).
    const status = e.code === 'window_closed' || e.code === 'window_exceeded' ? 409 : 400
    res.status(status).json({ error: e.message, code: e.code || null, expiresAt: e.expiresAt || null })
  }
}

const cancel = async (req, res) => {
  if (!guard(req, res)) return
  try { res.json(await svc.cancel(req.params.accId, req.params.id)) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, cancel }
