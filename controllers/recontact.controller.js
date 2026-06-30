'use strict'
const svc = require('../services/recontact')

const getConfig = async (req, res) => {
  try { res.json(await svc.getConfig(req.params.accId)) }
  catch (e) { res.status(500).json({ error: 'Error interno' }) }
}
const saveConfig = async (req, res) => {
  try { res.json(await svc.saveConfig(req.params.accId, req.body || {})) }
  catch (e) { res.status(500).json({ error: e.message || 'Error' }) }
}
const diagnose = async (req, res) => {
  try { res.json(await svc.diagnose(req.params.accId)) }
  catch (e) { res.status(500).json({ error: e.message || 'Error' }) }
}
const testNow = async (req, res) => {
  try { res.json(await svc.testNow(req.params.accId, req.body?.convId || null)) }
  catch (e) { res.status(500).json({ ok: false, reason: e.message || 'Error' }) }
}

module.exports = { getConfig, saveConfig, diagnose, testNow }
