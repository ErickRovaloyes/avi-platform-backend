'use strict'
/**
 * Data & Variables (backend port) — variable set/get, mapper, JSON parse/build,
 * formateador y código JS.
 */

const { interpolate, logDebug, safeJson, fmtDate, setVarBoth } = require('../common')

function getPath(obj, path) {
  if (!path) return obj
  return path.split('.').reduce((acc, k) => acc == null ? acc : acc[k], obj)
}
function setPath(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}

const dataNodes = [
  {
    type: 'variable', category: 'data', label: 'Variable',
    async exec(node, ctx) {
      const name = node.data?.nombre
      if (!name) throw new Error('Falta nombre de variable')
      if (node.data?.modo === 'get') {
        const v = ctx.variables[name]
        if (node.data?.destino) await setVarBoth(ctx, node.data.destino, v ?? '')
      } else {
        const v = interpolate(node.data?.valor || '', ctx.variables)
        await setVarBoth(ctx, name, v)
      }
    },
  },
  {
    type: 'mapper', category: 'data', label: 'Mapper',
    async exec(node, ctx) {
      const raw = interpolate(node.data?.entrada || '{}', ctx.variables)
      const obj = safeJson(raw, {})
      const lines = String(node.data?.mapeos || '').split('\n').map(s => s.trim()).filter(Boolean)
      const out = {}
      for (const line of lines) {
        const [src, dst] = line.split('→').map(s => s.trim())
        if (!src || !dst) continue
        setPath(out, dst, getPath(obj, src))
      }
      if (node.data?.salida) await setVarBoth(ctx, node.data.salida, JSON.stringify(out))
      ctx.variables._last_mapper_output = out
    },
  },
  {
    type: 'json_parse', category: 'data', label: 'JSON parse',
    async exec(node, ctx) {
      const raw = interpolate(node.data?.entrada || '', ctx.variables)
      const obj = safeJson(raw, null)
      if (obj == null) throw new Error('JSON inválido')
      const value = node.data?.path ? getPath(obj, node.data.path) : obj
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, typeof value === 'object' ? JSON.stringify(value) : value)
    },
  },
  {
    type: 'json_builder', category: 'data', label: 'JSON builder',
    async exec(node, ctx) {
      const out = {}
      const lines = String(node.data?.campos || '').split('\n').map(s => s.trim()).filter(Boolean)
      for (const line of lines) {
        const [k, ...rest] = line.split('=')
        if (!k) continue
        out[k.trim()] = interpolate(rest.join('='), ctx.variables)
      }
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(out))
      ctx.variables._last_built_json = out
    },
  },
  {
    type: 'formatter', category: 'data', label: 'Formateador',
    async exec(node, ctx) {
      const raw = interpolate(node.data?.valor || '', ctx.variables)
      const tipo = node.data?.tipo || 'date_long'
      let out = raw
      if (tipo.startsWith('date_') || tipo === 'time' || tipo === 'iso' || tipo === 'relative') {
        const preset = tipo === 'date_long' ? 'long' : tipo === 'date_short' ? 'date' : tipo === 'time' ? 'time' : tipo === 'iso' ? 'iso' : 'relative'
        out = fmtDate(raw, preset)
      } else if (tipo === 'number_int') {
        out = Math.round(Number(raw)).toLocaleString('es')
      } else if (tipo === 'number_pct') {
        out = (Number(raw) * 100).toFixed(1) + '%'
      } else if (tipo === 'currency') {
        out = new Intl.NumberFormat('es', { style: 'currency', currency: 'USD' }).format(Number(raw) || 0)
      }
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, out)
      ctx.variables._last_formatted = out
    },
  },
  {
    // Código JS — corre EN EL SERVIDOR. Se ocultan globals peligrosas (process,
    // require, etc.) como mitigación; aun así solo debe usarse con flujos de
    // confianza. Para lógica externa preferir un nodo HTTP request.
    type: 'custom_code', category: 'data', label: 'Código JS', timeoutMs: 5000,
    async exec(node, ctx) {
      const code = String(node.data?.codigo || '')
      function getPathLocal(obj, path) {
        if (obj == null || !path) return undefined
        const normalized = String(path).replace(/\[(\d+)\]/g, '.$1')
        return normalized.split('.').reduce((acc, k) => acc == null ? undefined : acc[k.trim()], obj)
      }
      const avi = {
        get:  (name) => ctx.variables[name],
        set:  async (name, value) => { await setVarBoth(ctx, name, value); return value },
        has:  (name) => Object.prototype.hasOwnProperty.call(ctx.variables, name),
        del:  (name) => { delete ctx.variables[name] },
        log:  (msg, detail = {}) => logDebug(ctx, 'flow_run', `💻 ${msg}`, detail),
        get lastMessage() { return ctx.variables._lastUserMessage },
        conversationId: ctx.convId, accountId: ctx.accId, agentId: ctx.agId,
        get vars()  { return ctx.variables },
        fetch:      (url, opts) => fetch(url, opts),
        json:       (text, fallback = null) => safeJson(text, fallback),
        getPath:    getPathLocal,
      }
      try {
        const AsyncFn = Object.getPrototypeOf(async function () {}).constructor
        // Sombras de globals peligrosas: el código no las recibe.
        const fn = new AsyncFn('avi', 'vars', 'process', 'require', 'global', 'globalThis', 'module', 'Buffer', code)
        const out = await fn(avi, ctx.variables, undefined, undefined, undefined, undefined, undefined, undefined)
        if (node.data?.destino && out !== undefined) {
          await setVarBoth(ctx, node.data.destino, typeof out === 'object' && out !== null ? JSON.stringify(out) : out)
        }
        ctx.variables._last_code_output = out
        logDebug(ctx, 'flow_run', '💻 Código ejecutado', { resultType: typeof out })
      } catch (e) { throw new Error(`Custom code: ${e.message}`) }
    },
  },
]

module.exports = { dataNodes }
