'use strict'
/**
 * AVI Platform — Flow Execution Engine (backend port de flowEngine.js).
 *
 * Ejecuta los flujos en el SERVIDOR. La lógica de cada nodo vive en flow/nodes/.
 * El estado "flujo en ejecución" se mantiene EN MEMORIA (Set de convIds) para
 * evitar ejecuciones concurrentes sobre la misma conversación.
 */

const store = require('./store')
const socket = require('../services/socket')
const { executeNode, getNode } = require('./nodes')

// Conversaciones con un flujo en curso (anti-reentrada). En memoria del proceso.
const _running = new Set()
function isRunning(convId) { return _running.has(convId) }

// ─── Main executor ─────────────────────────────────────────────────────────
async function executeFlow({ flowId, accId, agId, convId, triggerContext = {}, triggeredBy = { type: 'bot' }, outbound = null }) {
  const account = await store.loadAccount(accId)
  if (!account) return

  const flow = account.flows?.find(f => f.id === flowId)
  if (!flow || !flow.nodes?.length) return

  _running.add(convId)
  // Indicador "escribiendo…" en la bandeja mientras el flujo genera la respuesta.
  socket.emit(accId, 'flow:typing', { accId, agId, convId, typing: true })
  const trace = { steps: [], startedAt: Date.now(), status: 'success' }
  try {
    const variables = await buildVarContext(account, accId, agId, convId, triggerContext)
    const ctx = {
      flowId, accId, agId, convId, account,
      nodes: flow.nodes,
      variables,
      visited: new Set(),
      _trace: trace,
      _outbound: outbound,
      // Si el flujo lo dispara una campaña, marcamos los mensajes salientes con
      // su id para poder medir entregados/leídos/respondidos por campaña.
      _campaignId: triggeredBy?.campaignId || null,
    }
    logDebug(accId, agId, convId, 'flow_start', flow.name || 'Flujo', { trigger: flow.trigger, flowId })
    await runNode(flow.startNodeId, ctx)
  } catch (err) {
    logDebug(accId, agId, convId, 'error', `✗ Error en flujo: ${err.message}`, {})
    trace.status = 'error'
    trace.error = err.message
  } finally {
    _running.delete(convId)
    socket.emit(accId, 'flow:typing', { accId, agId, convId, typing: false })
    trace.endedAt = Date.now()
    // Persistimos la ejecución para el log global / registro de errores
    store.saveExecution({
      accId, agId, convId, flowId, flowName: flow.name,
      trigger: flow.trigger,
      status: trace.status, error: trace.error,
      durationMs: trace.endedAt - trace.startedAt, startedAt: trace.startedAt,
      source: triggeredBy?.type === 'test' ? 'test' : 'chat',
    })
  }
}

// ─── trigger dispatcher ────────────────────────────────────────────────────
async function runTrigger({ trigger, accId, agId, convId, context = {}, outbound = null }) {
  try {
    const account = await store.loadAccount(accId)
    const matching = (account?.flows || []).filter(f => {
      if (f.trigger !== trigger) return false
      if (trigger === 'keyword') {
        const kw = (f.triggerKeyword || '').trim().toLowerCase()
        if (!kw) return false
        return (context.message || '').toLowerCase().includes(kw)
      }
      return true
    })
    for (const f of matching) {
      await executeFlow({ flowId: f.id, accId, agId, convId, triggerContext: context, outbound })
    }
  } catch (err) {
    console.warn('[runTrigger]', err.message)
  }
}

// ─── Node runner ───────────────────────────────────────────────────────────
async function runNode(nodeId, ctx) {
  if (!nodeId || ctx.visited.has(nodeId)) return
  ctx.visited.add(nodeId)

  const node = ctx.nodes.find(n => n.id === nodeId)
  if (!node) return

  const def = getNode(node.type)
  if (!def) {
    logDebug(ctx.accId, ctx.agId, ctx.convId, 'error', `✗ Tipo de nodo desconocido: ${node.type}`, {})
    const errNext = node.connections?.error
    if (errNext) await runNode(errNext, ctx)
    return
  }

  logDebug(ctx.accId, ctx.agId, ctx.convId, 'flow_step', def.label || node.type, { nodeId, type: node.type })

  ctx._nextOverride = null
  ctx._suppressDefaultNext = false
  ctx.awaitInput = null
  ctx.awaitEvent = null

  try {
    await executeNode(node, ctx)
  } catch (err) {
    logDebug(ctx.accId, ctx.agId, ctx.convId, 'error', `✗ Error en [${node.type}]: ${err.message}`, {})
    const errNext = node.connections?.error
    if (errNext) await runNode(errNext, ctx)
    return
  }

  // Pausa por input/evento → el flujo se detiene aquí.
  if (ctx.awaitInput || ctx.awaitEvent) return
  if (ctx._nextOverride) { await runNode(ctx._nextOverride, ctx); return }
  if (ctx._suppressDefaultNext) return

  const successNext = node.connections?.success
  if (successNext) await runNode(successNext, ctx)
}

// ─── Helpers ───────────────────────────────────────────────────────────────
async function buildVarContext(account, accId, agId, convId, triggerContext = {}) {
  const convos = await store.readConvos(accId, agId)
  const conv = (convos || []).find(c => c.id === convId)
  const localVars = conv?.localVars || {}
  const ctx = { ...triggerContext }
  if (triggerContext.message) ctx._lastUserMessage = triggerContext.message

  ;(account.variables || []).forEach(v => {
    const val = localVars[v.id] ?? v.defaultValue ?? ''
    ctx[v.id] = val
    if (v.name) ctx[v.name] = val
  })
  for (const [k, v] of Object.entries(localVars)) {
    if (!(k in ctx)) ctx[k] = v
  }
  return ctx
}

function logDebug(accId, agId, convId, type, title, detail) {
  store.appendDebugEntry(accId, agId, convId, { type, title, detail })
}

module.exports = { executeFlow, runTrigger, isRunning }
