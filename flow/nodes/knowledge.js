'use strict'
/**
 * Knowledge base (backend port) — búsqueda vectorial + RAG sobre rag_chunks.
 * La API key de OpenAI se toma de ctx.account.openaiKey (ya efectiva: cuenta o
 * fallback de plataforma resuelto por loadPublicAccount).
 */

const { interpolate, logDebug, setVarBoth, sendBotMsg } = require('../common')
const { searchRelevantChunks, buildRagContext } = require('../../services/rag')

function openaiKey(ctx) { return ctx.account?.openaiKey || '' }

const knowledgeNodes = [
  {
    type: 'kb_search', category: 'knowledge', label: 'Buscar en KB',
    async exec(node, ctx) {
      const apiKey = openaiKey(ctx)
      if (!apiKey) throw new Error('Sin API Key de OpenAI (necesaria para embeddings)')
      const q = interpolate(node.data?.query || '', ctx.variables)
      const results = await searchRelevantChunks(q, ctx.accId, ctx.agId, apiKey)
      const top = (results || []).slice(0, Number(node.data?.top_k) || 5)
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(top))
      ctx.variables._last_kb_results = top
      logDebug(ctx, 'flow_run', `🔎 ${top.length} chunks encontrados`, { q })
    },
  },
  {
    type: 'kb_vector_search', category: 'knowledge', label: 'Búsqueda vectorial',
    async exec(node, ctx) {
      const apiKey = openaiKey(ctx)
      if (!apiKey) throw new Error('Sin API Key de OpenAI')
      const q = interpolate(node.data?.query || '', ctx.variables)
      const min = Number(node.data?.min_score) || 0.25
      const results = (await searchRelevantChunks(q, ctx.accId, ctx.agId, apiKey)) || []
      const filtered = results.filter(r => r.score >= min).slice(0, Number(node.data?.top_k) || 5)
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(filtered))
      ctx.variables._last_kb_results = filtered
    },
  },
  {
    type: 'rag', category: 'knowledge', label: 'RAG',
    async exec(node, ctx) {
      const apiKey = openaiKey(ctx)
      if (!apiKey) throw new Error('Sin API Key de OpenAI')
      const q = interpolate(node.data?.query || '', ctx.variables)
      const ctxBlock = await buildRagContext(q, ctx.accId, ctx.agId, apiKey)
      const destino = node.data?.destino || 'rag_context'
      await setVarBoth(ctx, destino, ctxBlock || '')
    },
  },
  {
    type: 'kb_doc_summary', category: 'knowledge', label: 'Resumen documental',
    async exec(node, ctx) {
      const apiKey = openaiKey(ctx)
      if (!apiKey) throw new Error('Sin API Key de OpenAI')
      const q = interpolate(node.data?.query || '', ctx.variables)
      const r = (await searchRelevantChunks(q, ctx.accId, ctx.agId, apiKey)) || []
      const text = r[0]?.text || r[0]?.content || ''
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, text)
      ctx.variables._last_kb_summary = text
    },
  },
  {
    type: 'kb_citations', category: 'knowledge', label: 'Citar fuentes',
    async exec(node, ctx) {
      const results = ctx.variables._last_kb_results || []
      const list = Array.isArray(results) ? results : []
      const lines = list.map((r, i) => `• ${r.fileName || r.filename || 'fuente ' + (i + 1)} (relevancia ${(r.score * 100).toFixed(0)}%)`).join('\n')
      const text = `${node.data?.prefix || 'Fuentes:'}\n${lines}`
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, text)
      if (node.data?.sendToUser !== false && lines) await sendBotMsg(ctx, text)
    },
  },
]

module.exports = { knowledgeNodes }
