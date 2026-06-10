'use strict'
/**
 * Integrations (backend port) — HTTP request, webhook N8N, API personalizada y
 * acción CRM. Antes estos nodos eran stubs en el servidor, así que el módulo
 * HTTP no ejecutaba ni guardaba la respuesta. Ahora corren de verdad.
 */

const pool = require('../../db')
const { uid } = require('../../utils')
const { interpolate, logDebug, safeJson, setVarBoth } = require('../common')
const store = require('../store')

// Acceso a rutas JSON: soporta "a.b.c", "a[0].b" y "a.0.b"
function getJsonPath(obj, path) {
  if (obj == null || !path) return undefined
  const normalized = String(path).replace(/\[(\d+)\]/g, '.$1')
  return normalized.split('.').reduce((acc, key) => {
    if (acc == null) return undefined
    const k = key.trim()
    if (!k) return acc
    return acc[k]
  }, obj)
}

async function httpExec(node, ctx, { withToken = false } = {}) {
  const method = node.data?.metodo || (withToken ? 'POST' : 'GET')
  const url = interpolate(node.data?.url || '', ctx.variables)
  if (!url) throw new Error('URL requerida')

  const headers = { 'Content-Type': 'application/json' }
  if (withToken && node.data?.token) headers['Authorization'] = `Bearer ${node.data.token}`
  for (const line of String(node.data?.headers || '').split('\n')) {
    const [k, ...rest] = line.split(':')
    if (k && rest.length) headers[k.trim()] = interpolate(rest.join(':').trim(), ctx.variables)
  }

  const opts = { method, headers }
  if (['POST', 'PUT', 'PATCH'].includes(method) && node.data?.body) {
    opts.body = interpolate(node.data.body, ctx.variables)
  }

  const res = await fetch(url, opts)
  const text = await res.text()
  const data = safeJson(text, text)
  if (!res.ok) {
    ctx.variables.error = `HTTP ${res.status}: ${String(text).slice(0, 200)}`
    throw new Error(ctx.variables.error)
  }

  // Guarda la respuesta COMPLETA en la variable asignada
  if (node.data?.destino) {
    await setVarBoth(ctx, node.data.destino, typeof data === 'object' ? JSON.stringify(data) : data)
  }
  ctx.variables._last_http_status = res.status
  ctx.variables._last_http_response = data

  // Extracciones JSON → variables
  const extract = Array.isArray(node.data?.extract) ? node.data.extract : []
  for (const m of extract) {
    if (!m?.var || !m?.path) continue
    const value = getJsonPath(data, m.path)
    const writable = typeof value === 'object' && value !== null ? JSON.stringify(value) : (value ?? '')
    await setVarBoth(ctx, m.var, writable)
    logDebug(ctx, 'flow_run', `📦 ${m.path} → ${m.var}`, { value: String(writable).slice(0, 200) })
  }
  logDebug(ctx, 'flow_run', `🌐 ${method} ${url} → ${res.status}`, { status: res.status, extracted: extract.length })
}

const integrationNodes = [
  {
    type: 'http_request', category: 'integrations', label: 'HTTP request', timeoutMs: 30000,
    async exec(node, ctx) { await httpExec(node, ctx) },
  },
  {
    type: 'custom_api', category: 'integrations', label: 'API personalizada', timeoutMs: 30000,
    async exec(node, ctx) { await httpExec(node, ctx, { withToken: true }) },
  },
  {
    type: 'webhook', category: 'integrations', label: 'Webhook (N8N)',
    async exec(node, ctx) {
      if (!node.data?.integrationId) throw new Error('Falta integrationId')
      const raw = interpolate(node.data?.payload || '{}', ctx.variables)
      const payload = safeJson(raw, {})
      payload._meta = { ...(payload._meta || {}), accountId: ctx.accId, agentId: ctx.agId, conversationId: ctx.convId }
      const r = await store.dispatchN8N(node.data.integrationId, payload, { forceSync: !!node.data?.destino })
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, typeof r?.data === 'object' ? JSON.stringify(r.data) : (r?.data || ''))
      if (!r?.ok) throw new Error(r?.error || 'Webhook falló')
    },
  },
  {
    type: 'crm_action', category: 'integrations', label: 'CRM (acción)',
    async exec(node, ctx) {
      const content = interpolate(node.data?.contenido || '', ctx.variables)
      const targetId = interpolate(node.data?.target_id || '', ctx.variables)
      if (node.data?.accion === 'create_task') {
        await pool.query(
          `INSERT INTO crm_tasks (id,account_id,target_type,target_id,title,status,priority,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          ['task_' + uid(), ctx.accId, 'contact', targetId, content, 'open', 'normal', 'bot', Date.now()]
        )
      } else {
        await pool.query(
          `INSERT INTO crm_notes (id,account_id,target_type,target_id,author_id,author_name,content,ts)
           VALUES (?,?,?,?,?,?,?,?)`,
          ['note_' + uid(), ctx.accId, 'contact', targetId, 'bot', 'Bot', content, Date.now()]
        )
      }
    },
  },
  // Stubs: lanzan error claro (igual que el frontend) hasta que se implementen.
  // (google_sheets se implementa en flow/nodes/google.js)
  { type: 'sql', category: 'integrations', label: 'SQL', async exec() { throw new Error('SQL aún no implementado — usa un Webhook N8N con SQL Node.') } },
  { type: 'email_send', category: 'integrations', label: 'Email', async exec() { throw new Error('Email aún no implementado — usa un Webhook N8N con SMTP.') } },
  { type: 'erp', category: 'integrations', label: 'ERP', async exec() { throw new Error('ERP aún no implementado — usa N8N o HTTP Request directo.') } },
]

module.exports = { integrationNodes }
