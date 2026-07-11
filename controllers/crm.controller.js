'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const convClassify = require('../services/convClassify')
const execSummary = require('../services/execSummary')
const businessCopilot = require('../services/businessCopilot')
const { sendEmail } = require('../services/email')

// ── Pipeline conversacional: crea deals desde chats con intención de compra ────
const socket = require('../services/socket')
const detectOpportunities = async (req, res) => {
  const { accId } = req.params
  try {
    const [pipes] = await pool.query('SELECT id, stages, cards FROM pipelines WHERE account_id=? ORDER BY id', [accId])
    if (!pipes.length) return res.status(400).json({ error: 'No hay pipeline. Crea uno primero en el CRM.' })
    const pipe = pipes[0]   // pipeline por defecto = el primero
    const stages = parseJ(pipe.stages, [])
    if (!stages.length) return res.status(400).json({ error: 'El pipeline no tiene etapas.' })
    const firstStage = [...stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]

    // Conversaciones que ya tienen un deal (por convId), en cualquier pipeline.
    const withDeal = new Set()
    for (const p of pipes) for (const c of parseJ(p.cards, [])) if (c.convId) withDeal.add(c.convId)

    const [convos] = await pool.query(
      "SELECT id, agent_id, guest_name, local_vars FROM conversations WHERE account_id=? AND buying_intent IN('media','alta') ORDER BY updated_at DESC LIMIT 150",
      [accId])
    let cards = parseJ(pipe.cards, [])
    const newCards = [], hist = []
    for (const cv of convos) {
      if (withDeal.has(cv.id) || newCards.length >= 50) continue
      const lv = parseJ(cv.local_vars, {})
      let contactName = cv.guest_name || ''
      if (lv.contact_id) { try { const [[ct]] = await pool.query('SELECT name FROM contacts WHERE id=? AND account_id=?', [lv.contact_id, accId]); if (ct?.name) contactName = ct.name } catch {} }
      const cardId = 'card_' + uid()
      newCards.push({ id: cardId, stageId: firstStage.id, title: `Oportunidad — ${contactName || 'Cliente'}`, contact: contactName, convId: cv.id, agentId: cv.agent_id, source: 'ia', createdAt: Date.now() })
      hist.push([accId, pipe.id, cardId, null, firstStage.id, Date.now()])
      withDeal.add(cv.id)
    }
    if (newCards.length) {
      cards = [...cards, ...newCards]
      await pool.query('UPDATE pipelines SET cards=? WHERE id=?', [JSON.stringify(cards), pipe.id])
      try { await pool.query('INSERT INTO deal_stage_history (account_id,pipeline_id,card_id,from_stage,to_stage,at) VALUES ?', [hist]) } catch {}
      socket.emit(accId, 'account:updated', { accId })
    }
    res.json({ ok: true, created: newCards.length, pipeline: pipe.id })
  } catch (err) { console.error('[detect opportunities]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Copiloto de negocio: pregunta → respuesta con base en los datos del CRM ────
const copilotAsk = async (req, res) => {
  const { accId } = req.params
  const question = String(req.body?.question || '').trim()
  const days = Math.min(Math.max(parseInt(req.body?.days) || 30, 1), 365)
  if (!question) return res.status(400).json({ error: 'Escribe una pregunta.' })
  try {
    const r = await businessCopilot.ask(accId, question, days)
    if (!r.ok) return res.status(400).json({ error: r.error })
    res.json(r)
  } catch (err) { console.error('[copilot]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Resumen ejecutivo (preview + envío por email al dueño) ───────────────────
const previewExecutiveSummary = async (req, res) => {
  const { accId } = req.params
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90)
  try { res.json(await execSummary.buildSummary(accId, days)) }
  catch (err) { console.error('[exec summary]', err); res.status(500).json({ error: 'Error interno' }) }
}
const sendExecutiveSummary = async (req, res) => {
  const { accId } = req.params
  const days = Math.min(Math.max(parseInt(req.body?.days) || 7, 1), 90)
  try {
    const sm = await execSummary.buildSummary(accId, days)
    const to = String(req.body?.to || sm.ownerEmail || '').trim()
    if (!to) return res.status(400).json({ error: 'No hay correo destino. Indica uno o configura el correo de la cuenta.', summary: sm })
    const html = execSummary.buildHtml(sm)
    const r = await sendEmail({ to, subject: `Resumen ejecutivo · ${sm.account}`, html })
    if (!r.ok) return res.status(502).json({ error: r.error || 'No se pudo enviar el correo', summary: sm })
    res.json({ ok: true, to, summary: sm })
  } catch (err) { console.error('[exec summary send]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Clasificación IA de conversaciones (tema + sentimiento) ─────────────────
// Corre por lotes incrementales usando el Modelo IA de Negocio del Super Panel.
// ── Retención / churn: recencia de compra de los clientes ────────────────────
const retention = async (req, res) => {
  const { accId } = req.params
  const DAY = 86400000, now = Date.now()
  try {
    // Último pedido por contacto (clientes = con al menos 1 pedido no cancelado).
    const [rows] = await pool.query(
      "SELECT contact_id, MAX(created_at) AS lastAt, COUNT(*) AS n, COALESCE(SUM(total),0) AS spend FROM orders WHERE account_id=? AND contact_id IS NOT NULL AND status NOT IN('draft','canceled') GROUP BY contact_id",
      [accId])
    const buckets = { active: 0, atRisk: 0, inactive: 0, churned: 0 }
    let atRiskValue = 0
    for (const r of rows) {
      const days = (now - Number(r.lastAt)) / DAY
      if (days <= 30) buckets.active++
      else if (days <= 60) { buckets.atRisk++; atRiskValue += Number(r.spend) }
      else if (days <= 90) { buckets.inactive++; atRiskValue += Number(r.spend) }
      else buckets.churned++
    }
    const [[cur]] = await pool.query("SELECT currency FROM orders WHERE account_id=? AND currency IS NOT NULL LIMIT 1", [accId]).catch(() => [[{}]])
    res.json({ customers: rows.length, buckets, atRiskValue: Math.round(atRiskValue), currency: cur?.currency || 'COP' })
  } catch (err) { console.error('[retention]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Velocidad + conversión del embudo (desde deal_stage_history) ─────────────
const pipelineVelocity = async (req, res) => {
  const { accId } = req.params
  try {
    const [pipes] = await pool.query('SELECT id, stages FROM pipelines WHERE account_id=?', [accId])
    const stageInfo = {}
    for (const p of pipes) for (const s of parseJ(p.stages, [])) stageInfo[s.id] = { name: s.name, color: s.color, order: s.order ?? 0 }

    const [hist] = await pool.query('SELECT card_id, to_stage, at FROM deal_stage_history WHERE account_id=? ORDER BY card_id, at ASC', [accId])
    const byCard = {}
    for (const h of hist) (byCard[h.card_id] ||= []).push(h)

    const DAY = 86400000
    const st = {}   // stageId -> { sumMs, nDur, entered, advanced }
    const get = id => (st[id] ||= { sumMs: 0, nDur: 0, entered: 0, advanced: 0 })
    for (const card in byCard) {
      const moves = byCard[card]
      for (let i = 0; i < moves.length; i++) {
        const sid = moves[i].to_stage
        if (!sid) continue
        const s = get(sid)
        s.entered++
        if (i < moves.length - 1) {
          s.advanced++
          const dur = moves[i + 1].at - moves[i].at
          if (dur > 0 && dur < 365 * DAY) { s.sumMs += dur; s.nDur++ }
        }
      }
    }
    const stages = Object.entries(st)
      .map(([id, s]) => ({
        stageId: id, name: stageInfo[id]?.name || id, color: stageInfo[id]?.color || null, order: stageInfo[id]?.order ?? 999,
        entered: s.entered, advanced: s.advanced,
        avgDays: s.nDur ? +(s.sumMs / s.nDur / DAY).toFixed(1) : null,
        throughputPct: s.entered ? Math.round(s.advanced / s.entered * 100) : 0,
      }))
      .sort((a, b) => a.order - b.order)
    res.json({ stages, totalMoves: hist.length })
  } catch (err) { console.error('[pipeline velocity]', err); res.status(500).json({ error: 'Error interno' }) }
}

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
    let forecast = 0, dealsLost = 0, lostValue = 0, lostReasons = {}
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
        // Estado del deal: explícito (card.status) o inferido por el nombre de la etapa.
        const wonByStage = stage?.name?.toLowerCase().match(/(ganado|cerrado|won)/) || c.won
        const lostByStage = stage?.name?.toLowerCase().match(/(perdido|lost)/)
        const status = c.status || (wonByStage ? 'won' : (lostByStage ? 'lost' : 'open'))
        if (status === 'won') { dealsWon += 1; wonValue += v }
        else if (status === 'lost') { dealsLost += 1; lostValue += v; const r = c.lostReason || 'Sin motivo'; lostReasons[r] = (lostReasons[r] || 0) + 1 }
        else { // abierto → contribuye al forecast ponderado
          const prob = Number(c.probability)
          forecast += v * (Number.isFinite(prob) ? Math.max(0, Math.min(100, prob)) / 100 : 0.5)
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
    // ROI de la IA: costo del asistente (source='chat') en el período.
    let aiCostUsd = 0, aiTokens = 0
    try {
      const [[t]] = await pool.query("SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(total_tokens),0) AS tk FROM token_usage WHERE account_id=? AND source='chat' AND ts BETWEEN ? AND ?", [accId, fromMs, toMs])
      aiCostUsd = Number(t?.cost || 0); aiTokens = Number(t?.tk || 0)
    } catch {}

    // Atención: tiempo de 1ª respuesta + desenlace (outcome).
    let avgFirstResponseMs = null, outcomes = [], attendedPct = 0
    try {
      const [[fr]] = await pool.query("SELECT AVG(first_response_ms) AS avg FROM conversations WHERE account_id=? AND first_response_ms IS NOT NULL AND created_at BETWEEN ? AND ?", [accId, fromMs, toMs])
      avgFirstResponseMs = fr?.avg != null ? Math.round(Number(fr.avg)) : null
      const [orow] = await pool.query("SELECT outcome, COUNT(*) AS n FROM conversations WHERE account_id=? AND outcome IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY outcome", [accId, fromMs, toMs])
      outcomes = orow.map(r => ({ outcome: r.outcome, count: Number(r.n) }))
      const tot = outcomes.reduce((s, o) => s + o.count, 0)
      const att = outcomes.find(o => o.outcome === 'atendido')?.count || 0
      attendedPct = tot ? Math.round(att / tot * 100) : 0
    } catch {}
    res.json({
      topics, sentiment, classifiedTotal, unclassified,
      avgFirstResponseMs, outcomes, attendedPct,
      aiCostUsd: +aiCostUsd.toFixed(4), aiTokens,
      aiCostPerConv: Number(convStats.total) > 0 ? +(aiCostUsd / Number(convStats.total)).toFixed(4) : 0,
      totalConversations: Number(convStats.total),
      humanHandoffs:      Number(convStats.humanHandoff),
      contactsAdded:      Number(contactsCount.total),
      dealsTotal,
      dealsValue,
      dealsWon,
      wonValue,
      dealsLost, lostValue, forecast: Math.round(forecast),
      lostReasons: Object.entries(lostReasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      dealsConversionPct: (dealsWon + dealsLost) > 0 ? (dealsWon / (dealsWon + dealsLost) * 100) : 0,
      dealsByStage: Object.entries(dealsByStage).map(([name, x]) => ({ name, count: x.count, value: x.value, color: x.color })),
      tasksOpen:    Number(tasksOpen.total),
      tasksOverdue: Number(tasksOverdue.total),
    })
  } catch (err) {
    console.error('[CRM KPIS]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = { listNotes, createNote, deleteNote, listTasks, createTask, updateTask, deleteTask, listActivity, kpis, logActivity, classifyConversations, previewExecutiveSummary, sendExecutiveSummary, pipelineVelocity, retention, copilotAsk, detectOpportunities }
