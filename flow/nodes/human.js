'use strict'
/**
 * Human assistance (backend port) — transferir, cola, ticket, nota, cerrar.
 * ticket/note insertan directamente en las tablas CRM (crm_tasks/crm_notes).
 */

const pool = require('../../db')
const { uid } = require('../../utils')
const { interpolate, logDebug, sendBotMsg, setAssignedTo } = require('../common')
const store = require('../store')
const assignment = require('../../services/assignment')

// Redacta con IA el mensaje de transferencia, usando el historial real de la conversación
// para que reconozca el motivo del cliente en vez de soltar un texto genérico. Si no hay
// API key o falla, devuelve null y el nodo usa el texto fijo configurado.
async function draftTransferMessage(ctx, { assignee, fallback, extra } = {}) {
  try {
    const { chat, getApiKey, detectProvider } = require('../../services/aiClient')
    const acc = ctx.account || {}
    const model = acc.defaultPromptModel || 'gpt-4o-mini'
    const provider = acc.defaultPromptProvider || detectProvider(model)
    const apiKey = getApiKey(acc, provider)
    if (!apiKey) return null

    const [rows] = await pool.query(
      "SELECT sender, content FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 10", [ctx.convId])
    const history = rows.reverse()
      .filter(r => r.content)
      .map(r => ({ role: r.sender === 'user' ? 'user' : 'assistant', content: String(r.content).slice(0, 600) }))
    if (!history.length) return null

    const sys = `Eres el asistente virtual de ${acc.name || 'la empresa'}. Vas a TRANSFERIR esta conversación a ` +
      `${assignee?.name ? `un asesor humano llamado ${assignee.name}` : 'un asesor humano'}. ` +
      `Redacta UN SOLO mensaje breve (máximo 2 frases) para el cliente, en su mismo idioma y en el tono de la conversación, que: ` +
      `(1) reconozca de forma concreta lo que el cliente venía pidiendo o el problema que planteó, y ` +
      `(2) le avise de que un asesor humano continúa la atención. ` +
      `No inventes datos, precios ni plazos. No te despidas ni firmes. Devuelve SOLO el texto del mensaje.` +
      (extra ? `\nTen en cuenta esta indicación del negocio: "${String(extra).slice(0, 300)}"` : '')

    const out = await chat({
      provider, model, apiKey,
      messages: [{ role: 'system', content: sys }, ...history],
      maxTokens: 200, temperature: 0.5, signal: ctx._signal,
    })
    const text = typeof out === 'string' ? out.trim() : ''
    return text && text.length > 3 ? text : null
  } catch (e) {
    logDebug(ctx, 'error', `No se pudo redactar el mensaje de transferencia con IA: ${e.message}`, {})
    return null
  }
}

const humanNodes = [
  {
    type: 'human_transfer', category: 'human', label: 'Transferir conversación',
    async exec(node, ctx) {
      const d = node.data || {}
      // ── A quién se asigna ──
      // Compat: los nodos antiguos solo tienen `asignar_a` (un miembro fijo).
      const cfg = {
        modo: d.asignar_modo || (d.asignar_a ? 'fijo' : 'ninguno'),
        asignar_a: d.asignar_a,
        equipoId: d.asignar_equipo,
        miembros: d.asignar_miembros,
        reparto: d.asignar_reparto || 'round_robin',
      }
      const scope = `transfer:${ctx.flowId || 'flow'}:${node.id || 'node'}`
      const { assignees, all } = await assignment.pickAssignees(ctx.accId, cfg, ctx.account?.members || [], scope)
      const assignee = assignees[0] || null

      // ── Mensaje al cliente ──
      // Con `mensaje_ia` lo redacta el Agente IA usando el contexto real de la conversación,
      // en vez del texto fijo (que suena genérico cuando el cliente venía con un problema).
      let msg = interpolate(d.mensaje || '', ctx.variables)
      if (d.mensaje_ia) {
        const draft = await draftTransferMessage(ctx, { assignee, fallback: msg, extra: d.mensaje })
        if (draft) msg = draft
      }
      if (msg.trim()) await sendBotMsg(ctx, msg)

      if (d.disable_ai !== false) {
        await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { aiEnabled: false })
      }
      if (assignee) await setAssignedTo(ctx, assignee)
      // "Todos a la vez": se asigna al primero (la conversación tiene un solo responsable)
      // pero se avisa al resto para que cualquiera pueda entrar.
      if (all && assignees.length > 1) {
        for (const a of assignees.slice(1)) {
          try { require('../../services/emailNotify').onAssigned(ctx.accId, { convId: ctx.convId, agId: ctx.agId, assigneeId: a.id, assignedBy: 'El flujo' }) } catch {}
        }
      }
      logDebug(ctx, 'flow_run',
        `🙋 Transferido${assignee ? ' → ' + assignee.name : ''}${all && assignees.length > 1 ? ` (+${assignees.length - 1} avisados)` : ''}`,
        { departamento: d.departamento, modo: cfg.modo, reparto: cfg.reparto, redactadoPorIA: !!d.mensaje_ia })
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
      const taskId = 'task_' + uid()
      try {
        await pool.query(
          `INSERT INTO crm_tasks (id,account_id,target_type,target_id,title,description,assignee_id,assignee_name,status,priority,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [taskId, ctx.accId, 'conversation', ctx.convId, title, description,
           assignee?.id || null, assignee?.name || '', 'open', node.data?.prioridad || 'normal', 'bot', Date.now()]
        )
        // Aviso por correo al asignado (si activó "Tareas → Correo").
        if (assignee?.id) { try { require('../../services/emailNotify').onTaskAssigned(ctx.accId, { taskId, title, assigneeId: assignee.id }) } catch {} }
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
      // Marca resuelto y detiene recontactos (no recontactar un caso ya cerrado).
      await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { localVars: { ...ctx.variables, _case_status: 'closed', _closed_at: Date.now(), _recontact_stopped: '1' } })
      logDebug(ctx, 'flow_run', '✅ Caso cerrado', {})
    },
  },
  {
    type: 'recontact_stop', category: 'human', label: 'Detener recontactos',
    async exec(node, ctx) {
      await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { localVars: { ...ctx.variables, _recontact_stopped: '1' } })
      logDebug(ctx, 'flow_run', '🛑 Recontactos detenidos en este chat', {})
    },
  },
]

module.exports = { humanNodes }
