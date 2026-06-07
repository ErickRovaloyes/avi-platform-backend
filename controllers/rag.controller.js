'use strict'
const pool = require('../db')
const { uid } = require('../utils')

const getRag = async (req, res) => {
  const { accId, agId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM rag_chunks WHERE account_id=? AND agent_id=?', [accId, agId])
    res.json(rows.map(r => ({ id: r.id, fileId: r.file_id, fileName: r.file_name, content: r.content, embedding: r.embedding ? JSON.parse(r.embedding) : null })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const putRag = async (req, res) => {
  const { accId, agId } = req.params
  const { chunks = [] } = req.body
  try {
    await pool.query('DELETE FROM rag_chunks WHERE account_id=? AND agent_id=?', [accId, agId])
    if (chunks.length) {
      const vals = chunks.map(c => [c.id || 'rag_' + uid(), accId, agId, c.fileId, c.fileName, c.content, c.embedding ? JSON.stringify(c.embedding) : null])
      await pool.query('INSERT INTO rag_chunks (id,account_id,agent_id,file_id,file_name,content,embedding) VALUES ?', [vals])
    }
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteRagFile = async (req, res) => {
  const { accId, agId, fileId } = req.params
  try {
    await pool.query('DELETE FROM rag_chunks WHERE account_id=? AND agent_id=? AND file_id=?', [accId, agId, fileId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { getRag, putRag, deleteRagFile }
