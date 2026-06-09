'use strict'
/**
 * Memory & Context (backend port) — guardar/leer/actualizar/eliminar memoria,
 * cargar perfil de contacto y historial de conversación.
 */

const pool = require('../../db')
const { parseJ } = require('../../utils')
const { interpolate, logDebug, setVarBoth } = require('../common')
const store = require('../store')

async function loadConv(ctx) {
  const list = await store.readConvos(ctx.accId, ctx.agId)
  return (list || []).find(c => c.id === ctx.convId) || null
}

const memoryNodes = [
  {
    type: 'memory_set', category: 'memory', label: 'Guardar memoria',
    async exec(node, ctx) {
      const key = node.data?.clave
      const value = interpolate(node.data?.valor || '', ctx.variables)
      const scope = node.data?.scope || 'conversation'
      if (!key) throw new Error('Clave requerida')
      if (scope === 'conversation') await setVarBoth(ctx, key, value)
      else if (scope === 'user')   { ctx.variables[`user_${key}`] = value; logDebug(ctx, 'flow_run', `💾 user[${key}] = ${value}`, {}) }
      else                          { ctx.variables[`account_${key}`] = value; logDebug(ctx, 'flow_run', `💾 account[${key}] = ${value}`, {}) }
    },
  },
  {
    type: 'memory_get', category: 'memory', label: 'Obtener memoria',
    async exec(node, ctx) {
      const key = node.data?.clave
      const scope = node.data?.scope || 'conversation'
      const lookupKey = scope === 'user' ? `user_${key}` : scope === 'account' ? `account_${key}` : key
      const value = ctx.variables[lookupKey]
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, value ?? '')
      logDebug(ctx, 'flow_run', `📖 ${lookupKey} = ${value ?? '(vacío)'}`, {})
    },
  },
  {
    type: 'memory_update', category: 'memory', label: 'Actualizar memoria',
    async exec(node, ctx) {
      const key = node.data?.clave
      const value = interpolate(node.data?.valor || '', ctx.variables)
      const scope = node.data?.scope || 'conversation'
      const fullKey = scope === 'user' ? `user_${key}` : scope === 'account' ? `account_${key}` : key
      if (scope === 'conversation') await setVarBoth(ctx, fullKey, value)
      else ctx.variables[fullKey] = value
    },
  },
  {
    type: 'memory_delete', category: 'memory', label: 'Eliminar memoria',
    async exec(node, ctx) {
      const key = node.data?.clave
      if (!key) return
      delete ctx.variables[key]
      try { await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, key, null) } catch {}
      logDebug(ctx, 'flow_run', `🗑 Memoria ${key} eliminada`, {})
    },
  },
  {
    type: 'user_profile', category: 'memory', label: 'Cargar perfil de usuario',
    async exec(node, ctx) {
      const lookup = node.data?.lookup || 'phone'
      const value = interpolate(node.data?.value || '', ctx.variables)
      if (!value) throw new Error('Falta valor a buscar')
      try {
        const [rows] = await pool.query('SELECT * FROM contacts WHERE account_id=?', [ctx.accId])
        const contacts = rows.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, ...parseJ(c.extra, {}) }))
        const m = contacts.find(c =>
          (lookup === 'phone' && c.phone === value) ||
          (lookup === 'email' && c.email === value) ||
          (lookup === 'guest' && (c.name || '').toLowerCase() === value.toLowerCase())
        )
        if (m) {
          ctx.variables.user_id    = m.id
          ctx.variables.user_name  = m.name
          ctx.variables.user_email = m.email
          ctx.variables.user_phone = m.phone
          ctx.variables.user_tags  = (m.tags || []).join(',')
          logDebug(ctx, 'flow_run', `👤 Perfil cargado: ${m.name}`, { id: m.id })
        } else {
          logDebug(ctx, 'flow_run', '👤 Perfil no encontrado', { lookup, value })
        }
      } catch (e) { logDebug(ctx, 'error', 'No se pudo cargar perfil', e.message) }
    },
  },
  {
    type: 'conversation_history', category: 'memory', label: 'Historial conversación',
    async exec(node, ctx) {
      const conv = await loadConv(ctx)
      const n = Math.max(1, Math.min(100, Number(node.data?.n) || 10))
      const slice = (conv?.messages || []).slice(-n).map(m => ({ sender: m.sender, content: m.content, ts: m.ts }))
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, JSON.stringify(slice))
      ctx.variables._conv_history = slice
    },
  },
]

module.exports = { memoryNodes }
