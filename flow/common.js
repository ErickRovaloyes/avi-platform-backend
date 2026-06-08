'use strict'
/**
 * Helpers compartidos por los executores de nodos (backend port de
 * flowNodes/common.js). La diferencia clave con el frontend: sendBotMsg ahora
 * corre en el servidor — persiste el mensaje en DB (emitiendo message:new por
 * socket) y entrega al canal externo vía ctx._outbound.
 */

const store = require('./store')

// Interpolación de variables — soporta {{var}}; deja literal si no existe
function interpolate(text, vars = {}) {
  if (text === undefined || text === null) return ''
  return String(text).replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const k = key.trim()
    return vars[k] ?? `{{${k}}}`
  })
}

function logDebug(ctx, type, title, detail) {
  // Fire-and-forget — nunca bloquea el flujo por un log de depuración
  try { store.appendDebugEntry(ctx.accId, ctx.agId, ctx.convId, { type, title, detail }) } catch {}
}

// Envía un mensaje del bot a la conversación.
// 1) Entrega al canal externo (WhatsApp/Messenger/IG) vía ctx._outbound y captura
//    el id del proveedor (wamid) para poder rastrear su estado (sent/delivered/read).
// 2) Persiste en DB con ese id + estado (emite message:new → la UI se actualiza).
async function sendBotMsg(ctx, content, metadata = {}) {
  const text = typeof content === 'string' ? content : String(content || '')
  let providerMsgId = null
  let status        = null
  if (ctx?._outbound && text) {
    try {
      const r = await ctx._outbound(text)
      providerMsgId = r?.messages?.[0]?.id || r?.message_id || null
      status = 'sent'
    } catch (e) {
      status = 'failed'
      logDebug(ctx, 'error', `✗ Error enviando al canal: ${e.message}`, {})
    }
  }
  await store.appendMsg(ctx.accId, ctx.agId, ctx.convId, {
    role: 'assistant', sender: 'ai',
    content: text,
    ts: Date.now(), fromFlow: true,
    ...(providerMsgId ? { waMessageId: providerMsgId } : {}),
    ...(status ? { status } : {}),
    ...metadata,
  })
}

function getVars(ctx) { return ctx?.variables || {} }

// Persiste una variable local en la conv Y actualiza ctx.variables en memoria,
// reflejándola bajo id, nombre y la clave cruda para que cualquier nodo la lea.
async function setVarBoth(ctx, key, value) {
  if (!key) return
  const def = (ctx.account?.variables || []).find(v => v.id === key || v.name === key)
  const canonicalId = def?.id || key
  ctx.variables[key] = value
  ctx.variables[canonicalId] = value
  if (def?.name) ctx.variables[def.name] = value
  try { await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, canonicalId, value) } catch {}
  // Traza para el modo debug del chat ("valor de variable cambiado")
  const label = def?.name || key
  const shown = typeof value === 'string' ? value : JSON.stringify(value)
  logDebug(ctx, 'variable_set', `Variable "${label}" = ${String(shown).slice(0, 120)}`, { key: canonicalId, value })
}

function resolveVar(ctx, idOrName) {
  if (!idOrName) return undefined
  return ctx.variables?.[idOrName]
}

function safeJson(str, fallback = null) {
  try { return JSON.parse(str) } catch { return fallback }
}

// Actualiza el assignedTo de la conversación activa
async function setAssignedTo(ctx, assignee) {
  await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { assignedTo: assignee })
}

module.exports = { interpolate, logDebug, sendBotMsg, getVars, setVarBoth, resolveVar, safeJson, setAssignedTo }
