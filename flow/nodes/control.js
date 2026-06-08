'use strict'
/**
 * Flow control (backend port) — if/switch/router/merge/loop/wait/wait_event/error.
 * Algunos nodos toman el control del ruteo vía ctx._nextOverride.
 */

const { interpolate, logDebug } = require('../common')

function compare(left, op, right) {
  const a = String(left ?? '').trim()
  const b = String(right ?? '').trim()
  const na = Number(a), nb = Number(b)
  switch (op) {
    case '==': case '=': return a === b
    case '!=': return a !== b
    case '>':  return na > nb
    case '<':  return na < nb
    case '>=': return na >= nb
    case '<=': return na <= nb
    case 'contains':    return a.toLowerCase().includes(b.toLowerCase())
    case 'starts_with': return a.toLowerCase().startsWith(b.toLowerCase())
    case 'ends_with':   return a.toLowerCase().endsWith(b.toLowerCase())
    case 'regex': { try { return new RegExp(b).test(a) } catch { return false } }
    case 'empty':     return !a
    case 'not_empty': return !!a
    default: return false
  }
}

function parseDuration(str) {
  const m = String(str || '').trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] || 's').toLowerCase()
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit] || 1000
  return n * mult
}

const controlNodes = [
  {
    type: 'if', category: 'control', label: 'IF',
    async exec(node, ctx) {
      const left  = interpolate(node.data?.campo || '', ctx.variables)
      const right = interpolate(node.data?.valor || '', ctx.variables)
      const match = compare(left, node.data?.operador, right)
      logDebug(ctx, 'flow_run', `⚡ IF: "${left}" ${node.data?.operador} "${right}" → ${match ? 'TRUE' : 'FALSE'}`, {})
      ctx._nextOverride = match ? node.connections?.success : node.connections?.error
      ctx._suppressDefaultNext = true
    },
  },
  {
    type: 'switch', category: 'control', label: 'Switch',
    async exec(node, ctx) {
      const value = interpolate(node.data?.campo || '', ctx.variables).trim().toLowerCase()
      let cases = {}
      try { cases = JSON.parse(node.data?.cases || '{}') } catch {}
      const target = cases[value] || cases.default || node.connections?.success
      logDebug(ctx, 'flow_run', `🔀 Switch: "${value}" → ${target || '(ninguno)'}`, {})
      ctx._nextOverride = target
      ctx._suppressDefaultNext = true
    },
  },
  {
    type: 'router', category: 'control', label: 'Router',
    async exec(node, ctx) {
      const value = (ctx.variables[node.data?.variable] || '').toString().trim().toLowerCase()
      const lines = String(node.data?.rutas || '').split('\n').map(s => s.trim()).filter(Boolean)
      const map = Object.fromEntries(lines.map(l => l.split(':').map(s => s.trim())))
      ctx._nextOverride = map[value] || node.connections?.success
      ctx._suppressDefaultNext = true
    },
  },
  {
    type: 'merge', category: 'control', label: 'Merge',
    async exec() { /* no-op */ },
  },
  {
    type: 'loop', category: 'control', label: 'Loop',
    async exec(node, ctx) {
      const key = `loop_${node.id}`
      const state = (ctx._loops ||= {})
      const cur = state[key] || { i: 0, items: null }
      if (node.data?.modo === 'array') {
        if (!cur.items) {
          let arr = []
          const raw = interpolate(node.data?.array || '[]', ctx.variables)
          try { arr = Array.isArray(raw) ? raw : JSON.parse(raw) } catch {}
          cur.items = arr
        }
        if (cur.i >= cur.items.length) {
          delete state[key]; ctx._nextOverride = node.connections?.error; ctx._suppressDefaultNext = true; return
        }
        if (node.data?.variable_indice) ctx.variables[node.data.variable_indice] = cur.i
        if (node.data?.variable_item)   ctx.variables[node.data.variable_item]   = cur.items[cur.i]
        cur.i++; state[key] = cur
      } else {
        const n = Math.max(1, Math.min(100, Number(node.data?.n) || 1))
        if (cur.i >= n) {
          delete state[key]; ctx._nextOverride = node.connections?.error; ctx._suppressDefaultNext = true; return
        }
        if (node.data?.variable_indice) ctx.variables[node.data.variable_indice] = cur.i
        cur.i++; state[key] = cur
      }
    },
  },
  {
    type: 'wait', category: 'control', label: 'Espera',
    async exec(node, ctx) {
      const ms = parseDuration(node.data?.duracion || (node.data?.seconds + 's') || '5s')
      const safe = Math.min(ms || 5000, 30000)
      logDebug(ctx, 'flow_run', `⏱ Esperando ${safe}ms`, {})
      await new Promise(r => setTimeout(r, safe))
    },
  },
  {
    type: 'wait_event', category: 'control', label: 'Esperar evento',
    async exec(node, ctx) {
      ctx.awaitEvent = { name: node.data?.evento, timeout: Number(node.data?.timeout) || 3600 }
      logDebug(ctx, 'flow_run', `📨 Esperando evento: ${ctx.awaitEvent.name}`, ctx.awaitEvent)
    },
  },
  {
    type: 'error_handler', category: 'control', label: 'Error handler',
    async exec(node, ctx) {
      const msg = interpolate(node.data?.mensaje_log || 'Error', ctx.variables)
      logDebug(ctx, 'error', `🛡 ${msg}`, { error: ctx.variables?.error })
    },
  },
]

module.exports = { controlNodes }
