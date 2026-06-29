'use strict'
const svc = require('../services/promptOptimizer')

const status = async (req, res) => {
  const { accId, agId } = req.params
  try { res.json(await svc.getStatus(accId, agId)) }
  catch (e) { console.error('[optimizer status]', e.message); res.status(500).json({ error: 'Error interno' }) }
}

const run = async (req, res) => {
  const { accId, agId } = req.params
  try {
    const r = await svc.run(accId, agId, req.user?.name || req.user?.email || '')
    res.json({ ok: true, ...r })
  } catch (e) { console.error('[optimizer run]', e.message); res.status(500).json({ error: e.message || 'Error' }) }
}

const suggestions = async (req, res) => {
  const { accId, agId } = req.params
  try { res.json({ suggestions: await svc.getSuggestions(accId, agId) }) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { status, run, suggestions }
