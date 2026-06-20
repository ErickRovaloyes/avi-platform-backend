'use strict'
/**
 * Registro de nodos del motor server-side.
 *
 * Camino crítico migrado: conversation, ai, control, knowledge, human.
 * Las demás categorías (memory, data, crm, integrations, analytics, calendar)
 * aún no se ejecutan en el backend — se registran como stubs benignos que
 * registran un aviso y dejan continuar el flujo por la salida de éxito, en vez
 * de romper toda la ejecución.
 */

const { registerMany, getNode, executeNode } = require('../registry')
const { conversationNodes } = require('./conversation')
const { aiNodes }           = require('./ai')
const { controlNodes }      = require('./control')
const { knowledgeNodes }    = require('./knowledge')
const { humanNodes }        = require('./human')
const { integrationNodes }  = require('./integrations')
const { dataNodes }         = require('./data')
const { memoryNodes }       = require('./memory')
const { crmNodes }          = require('./crm')
const { analyticsNodes }    = require('./analytics')
const { googleNodes }       = require('./google')
const { accumulateNodes }   = require('./accumulate')
const { calendarNodes }     = require('./calendar')

registerMany([
  ...conversationNodes,
  ...aiNodes,
  ...controlNodes,
  ...knowledgeNodes,
  ...humanNodes,
  ...integrationNodes,
  ...dataNodes,
  ...memoryNodes,
  ...crmNodes,
  ...analyticsNodes,
  ...googleNodes,
  ...accumulateNodes,
  ...calendarNodes,
])

// ── Aliases legacy (mismos que el frontend) ──────────────────────────────────
function alias(legacyType, canonicalType, transform) {
  const def = getNode(canonicalType)
  if (!def) return
  registerMany([{
    ...def, type: legacyType,
    exec: async (node, ctx) => def.exec(transform ? transform(node) : node, ctx),
  }])
}

alias('message', 'send_message', node => ({ ...node, data: { ...node.data, mensaje: node.data?.mensaje ?? node.data?.text } }))
alias('image',   'send_image',   node => ({ ...node, data: { ...node.data, url: node.data?.url, caption: node.data?.caption } }))
alias('file',    'send_document', node => ({ ...node, data: { ...node.data, url: node.data?.url, filename: node.data?.filename } }))
alias('openai',  'ai_chat',      node => ({ ...node, data: { ...node.data, prompt: node.data?.prompt, modelo: node.data?.model || 'gpt-4o-mini' } }))
alias('condition', 'if',         node => ({ ...node, data: { campo: `{{${node.data?.variableId || node.data?.variableName || ''}}}`, operador: '==', valor: node.data?.equals || '' } }))

// ── Stubs benignos para nodos aún no implementados (calendario) ──────────────
// El calendario requiere conectar Google/Outlook o un HTTP request; por ahora
// estos nodos no rompen el flujo (se omiten). El resto de categorías ya está
// migrado (conversation, ai, control, knowledge, human, integrations, data,
// memory, crm, analytics).
const NOT_YET_MIGRATED = [
  'calendar_reminder',
]
const stubDefs = NOT_YET_MIGRATED
  .filter(type => !getNode(type))
  .map(type => ({
    type, category: 'data', label: type,
    async exec(node, ctx) {
      const store = require('../store')
      try { store.appendDebugEntry(ctx.accId, ctx.agId, ctx.convId, { type: 'flow_run', title: `⏭ Nodo "${type}" aún no soportado en el servidor — se omite`, detail: {} }) } catch {}
    },
  }))
registerMany(stubDefs)

module.exports = { executeNode, getNode }
