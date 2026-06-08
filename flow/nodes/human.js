'use strict'
/**
 * Human assistance (backend port) — transferir, cola, ticket, nota, cerrar.
 * ticket/note insertan directamente en las tablas CRM (crm_tasks/crm_notes).
 */

const pool = require('../../db')
const { uid } = require('../../utils')
const { interpolate, logDebug, sendBotMsg, setAssignedTo } = require('../common')
const store = require('../store')

const humanNodes = [
  {
    type: 'human_transfer', category: 'human', label: 'Transferir conversación',
    async exec(node, ctx) {
      const msg = interpolate(node.data?.mensaje || '', ctx.variables)
      if (msg.trim()) await sendBotMsg(ctx, msg)
      if (node.data?.disable_ai !== false) {
        await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { aiEnabled: false })
      }
      const memberId = node.data?.asignar_a
      let assignee = null
      if (memberId) {
        const members = ctx.account?.members || []
        const m = members.find(x => x.id === memberId)
        if (m) assignee = { id: m.id, name: m.name }
      }
      if (assignee) await setAssignedTo(ctx, assignee)
      logDebug(ctx, 'flow_run', `🙋 Transferido${assignee ? ' → ' + assignee.name : ''}`, { departamento: node.data?.departamento })
    },
  },
  {
    type: 'human_queue', category: 'human', label: 'Cola',
    async exec(node, ctx) {
      logDebug(ctx, 'flow_run', `🚦 Cola: ${node.data?.cola} (prio: ${node.data?.prioridad})`, {})
      const cola = node.data?.cola
      if (cola) {
        await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { localVars: { ...ctx.variables, _queue: cola, _queue_priority: node.data?.prioridad } })
      }
    },
  },
  {
    type: 'human_ticket', category: 'human', label: 'Ticket',
    async exec(node, ctx) {
      const title = interpolate(node.data?.titulo || '', ctx.variables) || 'Ticket sin título'
      const description = interpolate(node.data?.descripcion || '', ctx.variables)
      const memberId = node.data?.asignar_a
      let assignee = null
      if (memberId) {
        const m = (ctx.account?.members || []).find(x => x.id === memberId)
        if (m) assignee = m
      }
      try {
        await pool.query(
          `INSERT INTO crm_tasks (id,account_id,target_type,target_id,title,description,assignee_id,assignee_name,status,priority,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['task_' + uid(), ctx.accId, 'conversation', ctx.convId, title, description,
           assignee?.id || null, assignee?.name || '', 'open', node.data?.prioridad || 'normal', 'bot', Date.now()]
        )
      } catch (e) { logDebug(ctx, 'error', `✗ Ticket no creado: ${e.message}`, {}) }
      logDebug(ctx, 'flow_run', `🎫 Ticket creado: ${title}`, {})
    },
  },
  {
    type: 'human_note', category: 'human', label: 'Nota interna',
    async exec(node, ctx) {
      const text = interpolate(node.data?.texto || '', ctx.variables)
      if (!text.trim()) return
      try {
        await pool.query(
          `INSERT INTO crm_notes (id,account_id,target_type,target_id,author_id,author_name,content,ts)
           VALUES (?,?,?,?,?,?,?,?)`,
          ['note_' + uid(), ctx.accId, 'conversation', ctx.convId, 'bot', 'Bot', text, Date.now()]
        )
      } catch (e) { logDebug(ctx, 'error', `✗ Nota no creada: ${e.message}`, {}) }
      logDebug(ctx, 'flow_run', '📝 Nota interna añadida', { text: text.slice(0, 100) })
    },
  },
  {
    type: 'human_close', category: 'human', label: 'Cerrar caso',
    async exec(node, ctx) {
      const msg = interpolate(node.data?.mensaje || '', ctx.variables)
      if (msg.trim()) await sendBotMsg(ctx, msg)
      await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { localVars: { ...ctx.variables, _case_status: 'closed', _closed_at: Date.now() } })
      logDebug(ctx, 'flow_run', '✅ Caso cerrado', {})
    },
  },
]

module.exports = { humanNodes }
