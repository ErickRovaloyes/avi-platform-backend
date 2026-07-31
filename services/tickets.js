'use strict'
/**
 * Acciones de "ticket" reutilizables por el nodo de flujo (motor backend y navegador)
 * y por el inbox. Un ticket es una **tarjeta de pipeline (deal)** o una **tarea del CRM**.
 * Muta `pipelines.cards` + `conversations.pipeline_cards` + `crm_tasks`, registra
 * `deal_stage_history` y emite eventos. Espejo de controllers/pipelines.controller.js.
 */
const pool = require('../db')
const socket = require('./socket')
const { uid, parseJ } = require('../utils')

async function loadConv(accId, convId) {
  const [[c]] = await pool.query('SELECT id, agent_id, guest_name, pipeline_cards FROM conversations WHERE id=? AND account_id=?', [convId, accId])
  return c || null
}

// ── Deals (tarjetas de pipeline) ───────────────────────────────────────────────
async function dealCreate(accId, conv, { pipelineId, stageId, title, value }) {
  const [[pipe]] = await pool.query('SELECT * FROM pipelines WHERE id=? AND account_id=?', [pipelineId, accId])
  if (!pipe) throw new Error('Pipeline no encontrado')
  const cards = parseJ(pipe.cards, [])
  const cardId = 'card_' + uid()
  cards.push({ id: cardId, stageId: stageId || null, title: title || conv.guest_name || 'Ticket', value: value || '', contact: conv.guest_name || '' })
  await pool.query('UPDATE pipelines SET cards=? WHERE id=?', [JSON.stringify(cards), pipelineId])
  if (stageId) { try { await pool.query('INSERT INTO deal_stage_history (account_id,pipeline_id,card_id,from_stage,to_stage,at) VALUES (?,?,?,?,?,?)', [accId, pipelineId, cardId, null, stageId, Date.now()]) } catch {} }
  const links = parseJ(conv.pipeline_cards, [])
  links.push({ pipelineId, cardId })
  await pool.query('UPDATE conversations SET pipeline_cards=? WHERE id=? AND account_id=?', [JSON.stringify(links), conv.id, accId])
  return { cardId }
}

async function dealMove(accId, conv, { pipelineId, stageId }) {
  const links = parseJ(conv.pipeline_cards, [])
  const link = links.find(l => l.pipelineId === pipelineId)
  if (!link) return dealCreate(accId, conv, { pipelineId, stageId })   // sin tarjeta en ese pipeline → la crea allí
  const [[pipe]] = await pool.query('SELECT * FROM pipelines WHERE id=? AND account_id=?', [pipelineId, accId])
  if (!pipe) throw new Error('Pipeline no encontrado')
  let cards = parseJ(pipe.cards, [])
  const old = cards.find(c => c.id === link.cardId)
  if (!old) return dealCreate(accId, conv, { pipelineId, stageId })    // la tarjeta ya no existe → recrea
  if (old.stageId !== stageId) { try { await pool.query('INSERT INTO deal_stage_history (account_id,pipeline_id,card_id,from_stage,to_stage,at) VALUES (?,?,?,?,?,?)', [accId, pipelineId, link.cardId, old.stageId || null, stageId, Date.now()]) } catch {} }
  cards = cards.map(c => c.id === link.cardId ? { ...c, stageId } : c)
  await pool.query('UPDATE pipelines SET cards=? WHERE id=?', [JSON.stringify(cards), pipelineId])
  return { cardId: link.cardId }
}

// ── Tareas del CRM ─────────────────────────────────────────────────────────────
async function taskCreate(accId, conv, { title, assigneeId, assigneeName, dueAt }) {
  const id = 'task_' + uid()
  await pool.query(
    `INSERT INTO crm_tasks (id, account_id, target_type, target_id, title, description, due_at, assignee_id, assignee_name, status, priority, type, refs, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, accId, 'conversation', conv.id, title || 'Tarea', '', dueAt || null, assigneeId || null, assigneeName || '', 'open', 'normal', 'general', '[]', 'flow', Date.now()]
  )
  // Aviso por correo al asignado (si activó "Tareas → Correo"), igual que el nodo de ticket humano.
  if (assigneeId) { try { require('./emailNotify').onTaskAssigned(accId, { taskId: id, title: title || 'Tarea', assigneeId, dueAt }) } catch {} }
  return { taskId: id }
}

async function taskSetStatus(accId, conv, status) {
  // Actúa sobre la tarea más reciente de la conversación (priorizando las abiertas).
  const [[t]] = await pool.query(
    "SELECT id FROM crm_tasks WHERE account_id=? AND target_type='conversation' AND target_id=? ORDER BY (status='open') DESC, created_at DESC LIMIT 1",
    [accId, conv.id]
  )
  if (!t) return { taskId: null }
  const sets = ['status=?']; const vals = [status]
  if (status === 'done') { sets.push('completed_at=?'); vals.push(Date.now()) }
  vals.push(t.id, accId)
  await pool.query(`UPDATE crm_tasks SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
  return { taskId: t.id }
}

// Punto de entrada único. opts = { tipo:'deal'|'tarea', accion:'crear'|'mover'|'cerrar',
// pipelineId, stageId, title, value, estado, assigneeId, assigneeName, dueAt }.
async function applyTicketAction(accId, convId, opts = {}) {
  const conv = await loadConv(accId, convId)
  if (!conv) throw new Error('Conversación no encontrada')
  const tipo = opts.tipo === 'tarea' ? 'tarea' : 'deal'
  const accion = ['crear', 'mover', 'cerrar'].includes(opts.accion) ? opts.accion : 'mover'
  let result = {}
  if (tipo === 'deal') {
    if (!opts.pipelineId) throw new Error('Falta el pipeline')
    if (accion === 'crear') result = await dealCreate(accId, conv, opts)
    else result = await dealMove(accId, conv, opts)      // mover y cerrar = mover a la etapa elegida
  } else {
    if (accion === 'crear') result = await taskCreate(accId, conv, opts)
    else result = await taskSetStatus(accId, conv, accion === 'cerrar' ? 'done' : (opts.estado === 'done' ? 'done' : 'open'))
  }
  socket.emit(accId, 'account:updated', { accId })
  socket.emit(accId, 'convos:updated', { accId, agId: conv.agent_id })
  return { ok: true, tipo, accion, ...result }
}

module.exports = { applyTicketAction }
