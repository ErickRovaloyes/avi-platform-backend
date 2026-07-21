'use strict'
/**
 * Helpers compartidos por los executores de nodos (backend port de
 * flowNodes/common.js). La diferencia clave con el frontend: sendBotMsg ahora
 * corre en el servidor — persiste el mensaje en DB (emitiendo message:new por
 * socket) y entrega al canal externo vía ctx._outbound.
 */

const store = require('./store')
const { resolveVar: resolveVarAlias } = require('../services/varAliases')

// Interpolación de variables — soporta {{var}}; deja literal si no existe.
// Las variables base del usuario (nombre/email/teléfono) se resuelven por alias:
// {{user_name}} y {{var_nombre}}/{{nombre}}/{{cliente_nombre}} son intercambiables.
function interpolate(text, vars = {}) {
  if (text === undefined || text === null) return ''
  return String(text).replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const k = key.trim()
    const v = resolveVarAlias(vars, k)
    return v ?? `{{${k}}}`
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
  // Contador de mensajes realmente enviados en este run. Lo usa el nodo Agente IA
  // para no duplicar: si una herramienta ya envió su propio mensaje (recurso,
  // catálogo, link de pago…), no se envía además la respuesta del modelo.
  if (ctx && (text.trim() || metadata?.media || metadata?.mediaUrl || metadata?.calendar)) {
    ctx._sentCount = (ctx._sentCount || 0) + 1
  }
  // Normaliza la media: los nodos pasan { media:{kind,url} } o { mediaUrl, kind }
  const media = metadata.media?.url
    ? metadata.media
    : (metadata.mediaUrl ? { kind: metadata.kind, url: metadata.mediaUrl, filename: metadata.filename } : null)

  let providerMsgId = null
  let status        = null
  let sendError     = null
  if (ctx?._outbound && (text || media || metadata.calendar)) {
    try {
      const r = await ctx._outbound(text, { media, caption: text, calendar: metadata.calendar })
      providerMsgId = r?.messages?.[0]?.id || r?.message_id || null
      status = 'sent'
    } catch (e) {
      status = 'failed'
      sendError = e.message
      logDebug(ctx, 'error', `✗ Error enviando al canal: ${e.message}`, { media: media?.kind || 'text' })
    }
  }
  await store.appendMsg(ctx.accId, ctx.agId, ctx.convId, {
    role: 'assistant', sender: 'ai',
    content: text,
    ts: Date.now(), fromFlow: true,
    ...(providerMsgId ? { waMessageId: providerMsgId } : {}),
    ...(status ? { status } : {}),
    ...(sendError ? { sendError } : {}),
    ...(ctx?._campaignId ? { campaignId: ctx._campaignId } : {}),
    ...metadata,
  })
  // Traza para el modo debug: qué mensaje se envió (texto o tipo de media)
  const mediaKind = media?.kind
  const dbgText = text || (mediaKind ? `[${mediaKind}]` : '')
  if (dbgText) logDebug(ctx, status === 'failed' ? 'error' : 'message_sent', dbgText, { text: dbgText, status: status || 'enviado', sendError })
  return { status, sendError, providerMsgId }
}

function getVars(ctx) { return ctx?.variables || {} }

// Persiste una variable local en la conv Y actualiza ctx.variables en memoria,
// reflejándola bajo id, nombre y la clave cruda para que cualquier nodo la lea.
async function setVarBoth(ctx, key, value) {
  if (!key) return
  const def = (ctx.account?.variables || []).find(v => v.id === key || v.name === key)
  const canonicalId = def?.id || key
  const prev = ctx.variables[canonicalId] // valor anterior, para mostrar from → to
  ctx.variables[key] = value
  ctx.variables[canonicalId] = value
  if (def?.name) ctx.variables[def.name] = value
  try { await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, canonicalId, value) } catch {}
  // Traza para el modo debug del chat ("valor de variable cambiado")
  const label = def?.name || key
  logDebug(ctx, 'variable_set', label, { name: label, from: prev, to: value })
}

function resolveVar(ctx, idOrName) {
  if (!idOrName) return undefined
  return ctx.variables?.[idOrName]
}

function safeJson(str, fallback = null) {
  try { return JSON.parse(str) } catch { return fallback }
}

// Formatea fecha en es-ES con presets (usado por el nodo Formateador)
function fmtDate(value, preset = 'long') {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  switch (preset) {
    case 'date':  return d.toLocaleDateString('es')
    case 'time':  return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    case 'iso':   return d.toISOString()
    case 'long':  return d.toLocaleString('es', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    case 'relative': {
      const diff = Date.now() - d.getTime()
      if (diff < 60000)    return 'hace un momento'
      if (diff < 3600000)  return `hace ${Math.floor(diff / 60000)} min`
      if (diff < 86400000) return `hace ${Math.floor(diff / 3600000)} h`
      return `hace ${Math.floor(diff / 86400000)} d`
    }
    default: return d.toLocaleString('es')
  }
}

// Actualiza el assignedTo de la conversación activa
async function setAssignedTo(ctx, assignee) {
  await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { assignedTo: assignee })
}

module.exports = { interpolate, logDebug, sendBotMsg, getVars, setVarBoth, resolveVar, safeJson, fmtDate, setAssignedTo }
