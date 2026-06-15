'use strict'
/**
 * Acumular mensajes (backend port) — junta los mensajes consecutivos del usuario
 * en uno solo, para que un agente IA los responda como un conjunto.
 *
 * Mecanismo (líder + debounce por sondeo, válido para canales y webchat):
 *   - El primer mensaje de la ráfaga se convierte en "líder": espera `waitSeconds`
 *     y vuelve a sondear la conversación; mientras lleguen mensajes nuevos, reinicia
 *     la espera. Cuando pasa la ventana sin novedades, concatena e interpreta todo.
 *   - Los mensajes posteriores ven que hay un líder activo y se detienen (su texto
 *     ya quedó guardado en la BD; el líder lo recoge al sondear).
 *   - Audios → su transcripción (ya viene como contenido). Imágenes y archivos →
 *     se interpretan con el modelo IA + miniprompt configurados.
 */

const { logDebug, setVarBoth } = require('../common')
const store = require('../store')
const mediaAI = require('../../services/mediaAI')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const isUserMsg = m => m.sender === 'user' || m.role === 'user'
const isBotMsg  = m => !isUserMsg(m)

async function loadConv(ctx) {
  const list = await store.readConvos(ctx.accId, ctx.agId)
  return (list || []).find(c => c.id === ctx.convId) || null
}

async function interpretMsg(ctx, node, m) {
  const kind = m.kind
  if (m.mediaId && kind === 'image') {
    try { return (await mediaAI.analyzeMedia(ctx.accId, m.mediaId, { model: node.data?.imageModel || 'gpt-4o-mini', prompt: node.data?.imagePrompt || '' })) || '[imagen]' }
    catch (e) { logDebug(ctx, 'error', 'No se pudo analizar imagen', e.message); return '[imagen]' }
  }
  if (m.mediaId && kind === 'file') {
    try { return (await mediaAI.analyzeMedia(ctx.accId, m.mediaId, { model: node.data?.fileModel || 'gpt-4o-mini', prompt: node.data?.filePrompt || '' })) || `[archivo: ${m.filename || ''}]` }
    catch (e) { logDebug(ctx, 'error', 'No se pudo analizar archivo', e.message); return `[archivo: ${m.filename || ''}]` }
  }
  if (m.mediaId && kind === 'audio') {
    if (m.content && m.content.trim()) return m.content
    try { return await mediaAI.transcribeMedia(ctx.accId, m.mediaId) } catch { return '[audio]' }
  }
  return m.content || ''
}

const accumulateNodes = [
  {
    type: 'accumulate_messages', category: 'conversation', label: 'Acumular mensajes',
    async exec(node, ctx) {
      const waitMs = Math.max(0, Math.round((Number(node.data?.waitSeconds) || 0) * 1000))
      const sep = node.data?.separator != null ? node.data.separator : '\n'

      const conv1 = await loadConv(ctx)
      if (!conv1) { logDebug(ctx, 'flow_run', 'Acumular: sin conversación', {}); return }
      const lv = conv1.localVars || {}
      const now = Date.now()
      const leaderTs = Number(lv._accumLeaderTs || 0)
      const LEADER_TTL = waitMs + 60000

      // Ya hay un acumulador activo → este branch se detiene (su mensaje ya está en BD).
      if (leaderTs && (now - leaderTs) < LEADER_TTL) {
        logDebug(ctx, 'flow_run', '📥 Acumular: mensaje añadido al lote en curso', {})
        ctx._suppressDefaultNext = true
        return
      }

      // Convertirse en líder (best-effort lock vía local_vars)
      const myId = 'ldr_' + Math.random().toString(36).slice(2)
      await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, '_accumLeaderTs', now)
      await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, '_accumLeaderId', myId)
      const convChk = await loadConv(ctx)
      if (convChk?.localVars?._accumLeaderId !== myId) { ctx._suppressDefaultNext = true; return }

      // No re-acumular lo ya consumido ni mensajes anteriores al último turno del bot.
      const lastBotTs = Math.max(0, ...(convChk.messages || []).filter(isBotMsg).map(m => Number(m.ts) || 0))
      const sinceTs = Math.max(Number(lv._accumWatermark || 0), lastBotTs)
      const collectNew = (conv, since) => (conv.messages || []).filter(m => isUserMsg(m) && (Number(m.ts) || 0) > since)

      let collected = collectNew(convChk, sinceTs)
      let lastSeen = collected.length ? Math.max(...collected.map(m => Number(m.ts) || 0)) : sinceTs

      // Debounce: espera y recoge mientras lleguen mensajes nuevos.
      while (waitMs > 0) {
        await sleep(waitMs)
        const convN = await loadConv(ctx)
        const more = collectNew(convN, lastSeen)
        if (!more.length) break
        collected = collected.concat(more)
        lastSeen = Math.max(lastSeen, ...more.map(m => Number(m.ts) || 0))
      }

      const parts = []
      for (const m of collected) {
        const t = await interpretMsg(ctx, node, m)
        if (t && String(t).trim()) parts.push(String(t).trim())
      }
      const result = parts.join(sep)

      await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, '_accumWatermark', lastSeen)
      await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, '_accumLeaderTs', 0)
      await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, '_accumLeaderId', '')

      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, result)
      ctx.variables._lastUserMessage = result
      ctx.variables._accumulated_count = parts.length
      logDebug(ctx, 'flow_run', `🧩 Acumulados ${parts.length} mensaje(s)`, { result: result.slice(0, 200) })
    },
  },
]

module.exports = { accumulateNodes }
