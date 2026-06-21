'use strict'
const pool = require('../db')
const { uid } = require('../utils')
const ragSvc = require('../services/rag')

// Resuelve la key de OpenAI efectiva (cuenta → plataforma) para los embeddings.
async function resolveOpenaiKey(accId) {
  try {
    const [[acc]] = await pool.query('SELECT openai_key FROM accounts WHERE id=?', [accId])
    if (acc?.openai_key && acc.openai_key.trim()) return acc.openai_key
    const [[pf]] = await pool.query('SELECT openai_key FROM platform_settings WHERE id=1')
    return pf?.openai_key || ''
  } catch { return '' }
}

// Recuperación SERVER-SIDE: hace el embedding de la consulta + búsqueda por coseno
// y devuelve SOLO el contexto top-K (pequeño). Evita que el navegador descargue
// TODOS los chunks con sus embeddings en cada mensaje (lo que rompía la plataforma).
// Público: lo usa el motor del navegador (webchat) sin sesión.
const getContext = async (req, res) => {
  const { accId, agId } = req.params
  const query = String(req.body?.query || '').slice(0, 2000)
  const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : null
  if (!query) return res.json({ context: '' })
  try {
    const apiKey = await resolveOpenaiKey(accId)
    if (!apiKey) return res.json({ context: '' })
    const context = await ragSvc.buildRagContext(query, accId, agId, apiKey, fileIds)
    res.json({ context: context || '' })
  } catch (err) { console.warn('[rag context]', err.message); res.json({ context: '' }) }
}

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

module.exports = { getRag, putRag, deleteRagFile, getContext }
