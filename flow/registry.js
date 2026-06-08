'use strict'
/**
 * Flow node registry (backend port) — catálogo central de tipos de nodo.
 * Solo conserva lo necesario para ejecutar: registro + executeNode con
 * retry/timeout/continueOnError.
 */

const _registry = new Map()

const BASE_DEFAULTS = {
  version: '1.0.0', active: true, description: '',
  fields: [], inputs: {}, outputs: {},
  retry: { enabled: false, maxAttempts: 3 },
  timeoutMs: 30000, continueOnError: false, logs: true, stub: false,
}

function registerNode(def) {
  if (!def?.type) throw new Error('Node definition needs a unique `type`')
  if (!def?.exec) def.exec = async () => { throw new Error(`Nodo ${def.type} sin implementación`) }
  if (!def?.category) def.category = 'data'
  const merged = { ...BASE_DEFAULTS, ...def }
  _registry.set(def.type, merged)
  return merged
}

function registerMany(arr) { arr.forEach(registerNode) }
function getNode(type) { return _registry.get(type) }
function listNodes() { return Array.from(_registry.values()) }

async function executeNode(node, ctx) {
  const def = _registry.get(node.type)
  if (!def) throw new Error(`Tipo de nodo no registrado: ${node.type}`)

  const attempts = def.retry?.enabled ? Math.max(1, def.retry.maxAttempts) : 1
  let lastErr = null
  for (let i = 1; i <= attempts; i++) {
    try {
      const exec = def.exec(node, ctx)
      const timeoutMs = def.timeoutMs || 30000
      return await Promise.race([
        exec,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
      ])
    } catch (err) {
      lastErr = err
      if (i < attempts) await new Promise(r => setTimeout(r, 250 * i))
    }
  }
  if (def.continueOnError) {
    if (ctx?.variables) ctx.variables.error = lastErr?.message || 'error'
    return null
  }
  throw lastErr
}

module.exports = { registerNode, registerMany, getNode, listNodes, executeNode }
