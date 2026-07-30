'use strict'
const svc = require('../services/dataTables')

const listTables = async (req, res) => {
  try { res.json({ tables: await svc.listTables(req.params.accId) }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}
const createTable = async (req, res) => {
  try { res.json(await svc.createTable(req.params.accId, req.body || {})) }
  catch (e) { console.error('[dataTables create]', e); res.status(500).json({ error: 'Error interno' }) }
}
const updateTable = async (req, res) => {
  try { res.json(await svc.updateTable(req.params.accId, req.params.id, req.body || {})) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}
const deleteTable = async (req, res) => {
  try { res.json(await svc.deleteTable(req.params.accId, req.params.id)) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

const listRows = async (req, res) => {
  try { res.json({ rows: await svc.listRows(req.params.accId, req.params.id, req.query || {}) }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}
const createRow = async (req, res) => {
  try { res.json(await svc.createRow(req.params.accId, req.params.id, req.body?.values || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
}
const updateRow = async (req, res) => {
  try { res.json(await svc.updateRow(req.params.accId, req.params.id, req.params.rowId, req.body?.values || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
}
const deleteRow = async (req, res) => {
  try { res.json(await svc.deleteRow(req.params.accId, req.params.id, req.params.rowId)) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// Proxy público: lo usa el webchat-en-navegador (el motor del servidor llama al
// servicio directo). Solo opera sobre tablas ai_enabled; no expone datos sensibles.
const tool = async (req, res) => {
  try {
    const { fn, args } = req.body || {}
    res.json(await svc.toolCall(req.params.accId, fn, args || {}))
  } catch (e) { res.status(400).json({ error: e.message }) }
}

module.exports = { listTables, createTable, updateTable, deleteTable, listRows, createRow, updateRow, deleteRow, tool }
