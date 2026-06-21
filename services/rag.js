'use strict'
/**
 * RAG service (backend port) — solo búsqueda semántica y construcción de contexto.
 * La ingesta de archivos sigue ocurriendo en el frontend; aquí solo leemos los
 * chunks ya embebidos desde la tabla rag_chunks y los puntuamos contra la query.
 */

const pool = require('../db')
const { parseJ } = require('../utils')

const TOP_K = 3
const EMBED_MODEL = 'text-embedding-3-small'
// Debe coincidir con EMBED_DIMS del frontend (los vectores de chunk y de consulta
// tienen que tener la misma dimensión para el coseno).
const EMBED_DIMS = 512

async function readRagChunks(accId, agId, fileIds = null) {
  let sql = 'SELECT * FROM rag_chunks WHERE account_id=? AND agent_id=?'
  const params = [accId, agId]
  // Filtra por los archivos asignados al prompt (si se indican).
  if (Array.isArray(fileIds) && fileIds.length) {
    sql += ` AND file_id IN (${fileIds.map(() => '?').join(',')})`
    params.push(...fileIds)
  }
  const [rows] = await pool.query(sql, params)
  return rows.map(r => ({
    id: r.id, fileId: r.file_id, fileName: r.file_name,
    content: r.content, embedding: parseJ(r.embedding, null),
  }))
}

async function getEmbedding(text, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: EMBED_DIMS }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Embeddings API error: ${err?.error?.message || res.status}`)
  }
  const data = await res.json()
  return data.data[0].embedding
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i] }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom ? dot / denom : 0
}

async function searchRelevantChunks(query, accId, agId, apiKey, fileIds = null) {
  const rawChunks = await readRagChunks(accId, agId, fileIds)
  if (!rawChunks?.length) return []
  const chunks = rawChunks.map(c => ({ ...c, text: c.content || c.text }))
  const queryEmbedding = await getEmbedding(query, apiKey)
  const scored = chunks
    .filter(c => Array.isArray(c.embedding))
    .map(chunk => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, TOP_K)
}

async function buildRagContext(query, accId, agId, apiKey, fileIds = null) {
  try {
    const relevant = await searchRelevantChunks(query, accId, agId, apiKey, fileIds)
    if (!relevant.length) return ''
    const contextText = relevant
      .filter(c => c.score > 0.25)
      .map((c, i) => `[Fragmento ${i + 1}]\n${c.text}`)
      .join('\n\n')
    if (!contextText) return ''
    return `\n\n---\n[CONTEXTO DE CONOCIMIENTO]\nUsa la siguiente información como referencia para responder:\n\n${contextText}\n---\n`
  } catch (err) {
    console.warn('[RAG] Error buscando contexto:', err.message)
    return ''
  }
}

module.exports = { readRagChunks, searchRelevantChunks, buildRagContext }
