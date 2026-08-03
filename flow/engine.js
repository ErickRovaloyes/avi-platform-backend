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

// AbortController por conversación: permite INTERRUMPIR la generación en curso cuando
// llega un mensaje nuevo del usuario (se cancela el fetch al modelo y se corta el flujo).
const _controllers = new Map()
function cancel(convId) {
  const c = _controllers.get(convId)
  if (c) { try { c.abort() } catch {} return true }
  return false
}
const isAborted = ctx => !!(ctx?._signal && ctx._signal.aborted)

// ─── Main executor ─────────────────────────────────────────────────────────
// `parentCtx` = flujo ANIDADO (una herramienta IA con action_type 'flow' lo invoca desde dentro
// de otro flujo). En ese caso NO se crea un AbortController propio (pisaba el del padre y lo
// borraba de _running/_controllers, rompiendo la interrupción por mensaje nuevo), se HEREDA el
// canal de salida `_outbound` (sin él los mensajes del sub-flujo se guardaban en BD pero nunca
// salían a WhatsApp/Messenger/Instagram) y al terminar se propaga `_sentCount` al padre para que
// sepa que la herramienta ya respondió y no duplique el mensaje.
async function executeFlow({ flowId, accId, agId, convId, triggerContext = {}, triggeredBy = { type: 'bot' }, outbound = null, parentCtx = null }) {
  const account = await store.loadAccount(accId)
  if (!account) return

  const flow = account.flows?.find(f => f.id === flowId)
  if (!flow || !flow.nodes?.length) return

  const nested = !!parentCtx
  let controller = null
  if (!nested) {
    _running.add(convId)
    controller = new AbortController()
    _controllers.set(convId, controller)
  }
  const signal = nested ? parentCtx._signal : controller.signal
  // Indicador "escribiendo…" en la bandeja mientras el flujo genera la respuesta.
  if (!nested) socket.emit(accId, 'flow:typing', { accId, agId, convId, typing: true })
  const trace = { steps: [], startedAt: Date.now(), status: 'success' }
  let ctx = null
  try {
    const variables = await buildVarContext(account, accId, agId, convId, triggerContext)
    ctx = {
      flowId, accId, agId, convId, account,
      nodes: flow.nodes,
      variables,
      visited: new Set(),
      _trace: trace,
      _outbound: outbound || parentCtx?._outbound || null,
      _signal: signal,   // para cancelar la generación (interrumpir)
      // Si el flujo lo dispara una campaña, marcamos los mensajes salientes con
      // su id para poder medir entregados/leídos/respondidos por campaña.
      _campaignId: triggeredBy?.campaignId || null,
    }
    logDebug(accId, agId, convId, 'flow_start', flow.name || 'Flujo', { trigger: flow.trigger, flowId })
    await runNode(flow.startNodeId, ctx)
  } catch (err) {
    // Interrupción por mensaje nuevo → no es un error real; se rehará el flujo.
    if (signal?.aborted) { trace.status = 'aborted' }
    else {
      logDebug(accId, agId, convId, 'error', `✗ Error en flujo: ${err.message}`, {})
      trace.status = 'error'
      trace.error = err.message
      try { socket.emit(accId, 'flow:error', { accId, agId, convId, flowId, flowName: flow.name, error: err.message, ts: Date.now() }) } catch {}
      try { require('../services/emailNotify').onFlowError(accId, { flowName: flow.name, error: err.message }) } catch {}
    }
  } finally {
    // Un sub-flujo NO libera el registro de ejecución del padre (rompería su interrupción)
    // ni apaga el indicador "escribiendo…": el padre sigue trabajando.
    if (!nested) {
      _running.delete(convId)
      if (_controllers.get(convId) === controller) _controllers.delete(convId)
      socket.emit(accId, 'flow:typing', { accId, agId, convId, typing: false })
    } else if (ctx?._sentCount) {
      // El padre necesita saber que el sub-flujo YA envió mensaje para no duplicarlo.
      parentCtx._sentCount = (parentCtx._sentCount || 0) + ctx._sentCount
    }
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
  if (isAborted(ctx)) return   // interrumpido por un mensaje nuevo → detener el flujo
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
    // Interrupción por mensaje nuevo (fetch abortado) → detener sin marcar error.
    if (isAborted(ctx) || err?.name === 'AbortError') return
    logDebug(ctx.accId, ctx.agId, ctx.convId, 'error', `✗ Error en [${node.type}]: ${err.message}`, {})
    const _flowName = ctx.account?.flows?.find(f => f.id === ctx.flowId)?.name || ''
    try { socket.emit(ctx.accId, 'flow:error', { accId: ctx.accId, agId: ctx.agId, convId: ctx.convId, flowId: ctx.flowId, flowName: _flowName, node: node.type, error: err.message, ts: Date.now() }) } catch {}
    try { require('../services/emailNotify').onFlowError(ctx.accId, { flowName: _flowName, node: node.type, error: err.message }) } catch {}
    const errNext = node.connections?.error
    if (errNext) await runNode(errNext, ctx)
    return
  }

  // Interrumpido mientras ejecutaba el nodo → no continuar al siguiente.
  if (isAborted(ctx)) return
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

module.exports = { executeFlow, runTrigger, isRunning, cancel }
