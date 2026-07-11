'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const convClassify = require('../services/convClassify')

// ── Clasificación IA de conversaciones (tema + sentimiento) ─────────────────
// Corre por lotes incrementales usando el Modelo IA de Negocio del Super Panel.
const classifyConversations = async (req, res) => {
  const { accId } = req.params
  const limit = Math.min(Math.max(parseInt(req.body?.limit) || 25, 1), 50)
  try {
    const r = await convClassify.classifyBatch(accId, { limit })
    if (!r.ok) return res.status(400).json({ error: r.error })
    res.json(r)
  } catch (err) { console.error('[crm classify]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Targets: 'contact' | 'deal' | 'conversation' | 'company'

// ── Activity log helper (used internally by notes/tasks) ────────────────────
async function logActivity({ accId, targetType, targetId, kind, title, detail, authorId, authorName }) {
  try {
    await pool.query(
      `INSERT INTO crm_activity (account_id, target_type, target_id, kind, title, detail, author_id, author_name, ts)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [accId, targetType, targetId, kind, title || '', detail || '', authorId || null, authorName || '', Date.now()]
    )
  } catch (e) { console.warn('[crm log]', e.message) }
}

// ── Notes ──────────────────────────────────────────────────────────────────
const listNotes = async (req, res) => {
  const { accId } = req.params
  const { targetType, targetId } = req.query
  try {
    const where = ['account_id=?']; const params = [accId]
    if (targetType) { where.push('target_type=?'); params.push(targetType) }
    if (targetId)   { where.push('target_id=?');   params.push(targetId) }
    const [rows] = await pool.query(`SELECT * FROM crm_notes WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT 500`, params)
    res.json(rows.map(r => ({
      id: r.id, targetType: r.target_type, targetId: r.target_id,
      authorId: r.author_id, authorName: r.author_name, content: r.content, ts: r.ts,
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createNote = async (req, res) => {
  const { accId } = req.params
  const { targetType, targetId, content = '' } = req.body || {}
  if (!targetType || !targetId) return res.status(400).json({ error: 'targetType y targetId requeridos' })
  if (!content.trim()) return res.status(400).json({ error: 'content requerido' })
  const id = 'note_' + uid()
  const authorName = req.user?.name || ''
  try {
    await pool.query(
      `INSERT INTO crm_notes (id, account_id, target_type, target_id, author_id, author_name, content, ts)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, accId, targetType, targetId, req.user?.id || null, authorName, content, Date.now()]
    )
    await logActivity({ accId, targetType, targetId, kind: 'note', title: 'Nota agregada', detail: content.slice(0, 200), authorId: req.user?.id, authorName })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteNote = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query('DELETE FROM crm_notes WHERE id=? AND account_id=?', [id, accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Tasks ──────────────────────────────────────────────────────────────────
const listTasks = async (req, res) => {
  const { accId } = req.params
  const { targetType, targetId, assigneeId, status } = req.query
  try {
    const where = ['account_id=?']; const params = [accId]
    if (targetType) { where.push('target_type=?'); params.push(targetType) }
    if (targetId)   { where.push('target_id=?');   params.push(targetId) }
    if (assigneeId) { where.push('assignee_id=?'); params.push(assigneeId) }
    if (status)     { where.push('status=?');      params.push(status) }
    const [rows] = await pool.query(
      `SELECT * FROM crm_tasks WHERE ${where.join(' AND ')} ORDER BY
        CASE WHEN status='open' THEN 0 ELSE 1 END,
        IFNULL(due_at, 9999999999999) ASC LIMIT 500`,
      params
    )
    res.json(rows.map(r => ({
      id: r.id, targetType: r.target_type, targetId: r.target_id,
      title: r.title, description: r.description,
      dueAt: r.due_at, assigneeId: r.assignee_id, assigneeName: r.assignee_name,
      status: r.status, priority: r.priority,
      refs: parseJ(r.refs, []),
      createdBy: r.created_by, createdAt: r.created_at, completedAt: r.completed_at,
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createTask = async (req, res) => {
  const { accId } = req.params
  const { targetType = null, targetId = null, title = '', description = '', dueAt = null, assigneeId = null, assigneeName = '', priority = 'normal', refs = [] } = req.body || {}
  if (!title.trim()) return res.status(400).json({ error: 'title requerido' })
  const id = 'task_' + uid()
  try {
    await pool.query(
      `INSERT INTO crm_tasks (id, account_id, target_type, target_id, title, description, due_at, assignee_id, assignee_name, status, priority, refs, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, accId, targetType, targetId, title.trim(), description, dueAt, assigneeId, assigneeName, 'open', priority, JSON.stringify(Array.isArray(refs) ? refs : []), req.user?.name || '', Date.now()]
    )
    if (targetType && targetId) {
      await logActivity({ accId, targetType, targetId, kind: 'task', title: 'Nueva tarea: ' + title, detail: assigneeName ? `Asignada a ${assigneeName}` : '', authorId: req.user?.id, authorName: req.user?.name })
    }
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateTask = async (req, res) => {
  const { accId, id } = req.params
  const { title, description, dueAt, assigneeId, assigneeName, status, priority, refs } = req.body || {}
  try {
    const sets = []; const vals = []
    if (title       !== undefined) { sets.push('title=?');         vals.push(title) }
    if (description !== undefined) { sets.push('description=?');   vals.push(description) }
    if (dueAt       !== undefined) { sets.push('due_at=?');        vals.push(dueAt) }
    if (assigneeId  !== undefined) { sets.push('assignee_id=?');   vals.push(assigneeId) }
    if (assigneeName!== undefined) { sets.push('assignee_name=?'); vals.push(assigneeName) }
    if (refs        !== undefined) { sets.push('refs=?');          vals.push(JSON.stringify(Array.isArray(refs) ? refs : [])) }
    if (status      !== undefined) {
      sets.push('status=?'); vals.push(status)
      if (status === 'done') { sets.push('completed_at=?'); vals.push(Date.now()) }
    }
    if (priority    !== undefined) { sets.push('priority=?');      vals.push(priority) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id, accId)
    await pool.query(`UPDATE crm_tasks SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    // Log completion as an activity
    if (status === 'done') {
      const [[t]] = await pool.query('SELECT target_type, target_id, title FROM crm_tasks WHERE id=?', [id])
      if (t?.target_type && t?.target_id) {
        await logActivity({ accId, targetType: t.target_type, targetId: t.target_id, kind: 'task_done', title: 'Tarea completada: ' + t.title, authorId: req.user?.id, authorName: req.user?.name })
      }
    }
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteTask = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query('DELETE FROM crm_tasks WHERE id=? AND account_id=?', [id, accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Activity timeline (read-only feed) ─────────────────────────────────────
const listActivity = async (req, res) => {
  const { accId } = req.params
  const { targetType, targetId, limit = 50 } = req.query
  try {
    const where = ['account_id=?']; const params = [accId]
    if (targetType) { where.push('target_type=?'); params.push(targetType) }
    if (targetId)   { where.push('target_id=?');   params.push(targetId) }
    const [rows] = await pool.query(
      `SELECT * FROM crm_activity WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`,
      [...params, Math.min(parseInt(limit) || 50, 200)]
    )
    res.json(rows.map(r => ({
      id: r.id, targetType: r.target_type, targetId: r.target_id,
      kind: r.kind, title: r.title, detail: r.detail,
      authorId: r.author_id, authorName: r.author_name, ts: r.ts,
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── KPIs ──────────────────────────────────────────────────────────────────
const kpis = async (req, res) => {
  const { accId } = req.params
  const { from = 0, to = Date.now() } = req.query
  const fromMs = parseInt(from) || 0
  const toMs   = parseInt(to)   || Date.now()
  try {
    // Conversations / messages (already exist)
    const [[convStats]] = await pool.query(
      'SELECT COUNT(*) AS total, COUNT(CASE WHEN ai_enabled=0 THEN 1 END) AS humanHandoff FROM conversations WHERE account_id=? AND created_at BETWEEN ? AND ?',
      [accId, fromMs, toMs]
    )
    // Pipelines: walk every pipeline's cards (stored as JSON) and total their value
    const [pipelines] = await pool.query('SELECT * FROM pipelines WHERE account_id=?', [accId])
    let dealsTotal = 0, dealsValue = 0, dealsByStage = {}, dealsWon = 0, wonValue = 0
    for (const p of pipelines) {
      let stages = []; let cards = []
      try { stages = JSON.parse(p.stages) || [] } catch {}
      try { cards  = JSON.parse(p.cards)  || [] } catch {}
      const stageById = Object.fromEntries(stages.map(s => [s.id, s]))
      for (const c of cards) {
        const ts = c.createdAt || c.updatedAt || 0
        if (ts && (ts < fromMs || ts > toMs)) continue
        dealsTotal += 1
        const v = Number(c.value || 0)
        dealsValue += v
        const stage = stageById[c.stageId]
        const key = stage?.name || c.stageId || '—'
        if (!dealsByStage[key]) dealsByStage[key] = { count: 0, value: 0, color: stage?.color }
        dealsByStage[key].count += 1
        dealsByStage[key].value += v
        if (stage?.name?.toLowerCase().match(/(ganado|cerrado|won)/) || c.won) {
          dealsWon += 1; wonValue += v
        }
      }
    }
    const [[contactsCount]] = await pool.query(
      'SELECT COUNT(*) AS total FROM contacts WHERE account_id=? AND created_at BETWEEN ? AND ?',
      [accId, fromMs, toMs]
    )
    const [[tasksOpen]] = await pool.query(
      "SELECT COUNT(*) AS total FROM crm_tasks WHERE account_id=? AND status='open'", [accId]
    )
    const [[tasksOverdue]] = await pool.query(
      "SELECT COUNT(*) AS total FROM crm_tasks WHERE account_id=? AND status='open' AND due_at IS NOT NULL AND due_at < ?",
      [accId, Date.now()]
    )
    // Voz del cliente: distribución de temas + sentimiento (de la clasificación IA).
    let topics = [], sentiment = [], classifiedTotal = 0, unclassified = 0
    try {
      const [tr] = await pool.query("SELECT topic, COUNT(*) AS n FROM conversations WHERE account_id=? AND topic IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY topic ORDER BY n DESC", [accId, fromMs, toMs])
      topics = tr.map(r => ({ topic: r.topic, count: Number(r.n) }))
      const [sr] = await pool.query("SELECT sentiment, COUNT(*) AS n FROM conversations WHERE account_id=? AND sentiment IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY sentiment", [accId, fromMs, toMs])
      sentiment = sr.map(r => ({ sentiment: r.sentiment, count: Number(r.n) }))
      classifiedTotal = topics.reduce((s, t) => s + t.count, 0)
      const [[u]] = await pool.query("SELECT COUNT(*) AS n FROM conversations WHERE account_id=? AND classified_at IS NULL", [accId])
      unclassified = Number(u?.n || 0)
    } catch {}
    res.json({
      topics, sentiment, classifiedTotal, unclassified,
      totalConversations: Number(convStats.total),
      humanHandoffs:      Number(convStats.humanHandoff),
      contactsAdded:      Number(contactsCount.total),
      dealsTotal,
      dealsValue,
      dealsWon,
      wonValue,
      dealsConversionPct: dealsTotal > 0 ? (dealsWon / dealsTotal * 100) : 0,
      dealsByStage: Object.entries(dealsByStage).map(([name, x]) => ({ name, count: x.count, value: x.value, color: x.color })),
      tasksOpen:    Number(tasksOpen.total),
      tasksOverdue: Number(tasksOverdue.total),
    })
  } catch (err) {
    console.error('[CRM KPIS]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = { listNotes, createNote, deleteNote, listTasks, createTask, updateTask, deleteTask, listActivity, kpis, logActivity, classifyConversations }
