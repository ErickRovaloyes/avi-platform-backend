'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const convClassify = require('../services/convClassify')
const convQA = require('../services/convQA')

// ── QA del asistente: evaluar calidad (lote) + lista a revisar ────────────────
const qaRun = async (req, res) => {
  const { accId } = req.params
  const limit = Math.min(Math.max(parseInt(req.body?.limit) || 15, 1), 40)
  try {
    const r = await convQA.qaBatch(accId, { limit })
    if (!r.ok) return res.status(400).json({ error: r.error })
    res.json(r)
  } catch (err) { console.error('[qa run]', err); res.status(500).json({ error: 'Error interno' }) }
}
const qaReview = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query(
      "SELECT id, agent_id, guest_name, channel_type, qa_score, qa_flag, updated_at FROM conversations WHERE account_id=? AND qa_score IS NOT NULL AND qa_score < 50 ORDER BY qa_score ASC, updated_at DESC LIMIT 20",
      [accId])
    res.json({ items: rows.map(r => ({ id: r.id, agentId: r.agent_id, guestName: r.guest_name, channel: r.channel_type, score: r.qa_score, flag: r.qa_flag || '', updatedAt: r.updated_at })) })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}
const execSummary = require('../services/execSummary')
const businessCopilot = require('../services/businessCopilot')
const { sendEmail } = require('../services/email')

// ── Lead scoring: puntúa cada deal (0-100) por probabilidad de cierre ─────────
const leadScores = async (req, res) => {
  const { accId } = req.params
  const DAY = 86400000, now = Date.now()
  try {
    const [pipes] = await pool.query('SELECT cards FROM pipelines WHERE account_id=?', [accId])
    const allCards = [], convIds = new Set()
    for (const p of pipes) for (const c of parseJ(p.cards, [])) { allCards.push(c); if (c.convId) convIds.add(c.convId) }
    const convById = {}
    if (convIds.size) {
      const [convos] = await pool.query('SELECT id, buying_intent, sentiment, updated_at FROM conversations WHERE account_id=? AND id IN (?)', [accId, [...convIds]])
      for (const cv of convos) convById[cv.id] = cv
    }
    const INTENT = { alta: 45, media: 30, baja: 12, nula: 0 }
    const SENT = { positivo: 15, neutral: 5, negativo: -12 }
    const scores = {}
    for (const c of allCards) {
      if (c.status === 'won') { scores[c.id] = 100; continue }
      if (c.status === 'lost') { scores[c.id] = 0; continue }
      let sc = 20
      const cv = convById[c.convId]
      if (cv) {
        sc += INTENT[cv.buying_intent] ?? 0
        sc += SENT[cv.sentiment] ?? 0
        const days = (now - Number(cv.updated_at || 0)) / DAY
        if (days <= 3) sc += 15; else if (days <= 14) sc += 5; else sc -= 8
      }
      if (c.probability != null && c.probability !== '') sc = Math.round((sc + Number(c.probability)) / 2)
      scores[c.id] = Math.max(0, Math.min(100, Math.round(sc)))
    }
    res.json({ scores })
  } catch (err) { console.error('[lead scores]', err); res.status(500).json({ error: 'Error interno' }) }
}

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
      "SELECT id, agent_id, guest_name, local_vars, origin FROM conversations WHERE account_id=? AND buying_intent IN('media','alta') ORDER BY updated_at DESC LIMIT 150",
      [accId])
    let cards = parseJ(pipe.cards, [])
    const newCards = [], hist = []
    for (const cv of convos) {
      if (withDeal.has(cv.id) || newCards.length >= 50) continue
      const lv = parseJ(cv.local_vars, {})
      let contactName = cv.guest_name || ''
      if (lv.contact_id) { try { const [[ct]] = await pool.query('SELECT name FROM contacts WHERE id=? AND account_id=?', [lv.contact_id, accId]); if (ct?.name) contactName = ct.name } catch {} }
      const cardId = 'card_' + uid()
      // Origen del lead heredado del chat (directo/anuncio/link) → se muestra y se
      // puede filtrar en el pipeline. No toca `source:'ia'` (marca "Detectado por IA").
      const origin = parseJ(cv.origin, null)
      // `contactId` es el vínculo DURO con la ficha del contacto (card.contact es solo un
      // nombre y no distingue homónimos). La ficha 360° lo usa para listar sus tickets.
      newCards.push({ id: cardId, stageId: firstStage.id, title: `Oportunidad — ${contactName || 'Cliente'}`, contact: contactName, ...(lv.contact_id ? { contactId: lv.contact_id } : {}), convId: cv.id, agentId: cv.agent_id, source: 'ia', ...(origin?.type ? { origin, originType: origin.type } : {}), createdAt: Date.now() })
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

// ── Asistente de la plataforma: pregunta → respuesta sobre CÓMO usar AVI ───────
const platformAsk = async (req, res) => {
  const { accId } = req.params
  const question = String(req.body?.question || '').trim()
  if (!question) return res.status(400).json({ error: 'Escribe una pregunta.' })
  try {
    const r = await require('../services/platformAssistant').ask(accId, question)
    if (!r.ok) return res.status(400).json({ error: r.error })
    res.json(r)
  } catch (err) { console.error('[platformAssistant]', err); res.status(500).json({ error: 'Error interno' }) }
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
  const { targetType, targetId, assigneeId, status, type } = req.query
  try {
    const where = ['account_id=?']; const params = [accId]
    if (targetType) { where.push('target_type=?'); params.push(targetType) }
    if (targetId)   { where.push('target_id=?');   params.push(targetId) }
    if (assigneeId) { where.push('assignee_id=?'); params.push(assigneeId) }
    if (status)     { where.push('status=?');      params.push(status) }
    if (type)       { where.push('type=?');        params.push(type) }
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
      status: r.status, priority: r.priority, type: r.type || 'general',
      refs: parseJ(r.refs, []),
      // Tareas de tipo "flujo": qué flujo corre al vencer y, si falló, por qué. El motivo se
      // devuelve para poder mostrarlo: si no, una tarea que no hizo nada no tiene explicación.
      flowId: r.flow_id || '', flowError: r.flow_error || '',
      createdBy: r.created_by, createdAt: r.created_at, completedAt: r.completed_at,
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createTask = async (req, res) => {
  const { accId } = req.params
  const { targetType = null, targetId = null, title = '', description = '', dueAt = null, assigneeId = null, assigneeName = '', priority = 'normal', type = 'general', refs = [], flowId = null } = req.body || {}
  if (!title.trim()) return res.status(400).json({ error: 'title requerido' })
  // Una tarea de tipo "flujo" sin flujo no haría nada al vencer, y el usuario no se enteraría
  // hasta no ver que no pasó nada. Mejor rechazarla al crearla.
  if (type === 'flujo' && !String(flowId || '').trim()) return res.status(400).json({ error: 'Elige el flujo que se ejecutará al vencer la tarea.' })
  const id = 'task_' + uid()
  try {
    await pool.query(
      `INSERT INTO crm_tasks (id, account_id, target_type, target_id, title, description, due_at, assignee_id, assignee_name, status, priority, type, refs, flow_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, accId, targetType, targetId, title.trim(), description, dueAt, assigneeId, assigneeName, 'open', priority, type || 'general', JSON.stringify(Array.isArray(refs) ? refs : []), flowId || null, req.user?.name || '', Date.now()]
    )
    if (targetType && targetId) {
      await logActivity({ accId, targetType, targetId, kind: 'task', title: 'Nueva tarea: ' + title, detail: assigneeName ? `Asignada a ${assigneeName}` : '', authorId: req.user?.id, authorName: req.user?.name })
    }
    // Aviso por correo al asignado (si activó "Tareas → Correo").
    if (assigneeId && assigneeId !== req.user?.id) {
      try { require('../services/emailNotify').onTaskAssigned(accId, { taskId: id, title: title.trim(), assigneeId, dueAt }) } catch {}
    }
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateTask = async (req, res) => {
  const { accId, id } = req.params
  const { title, description, dueAt, assigneeId, assigneeName, status, priority, type, refs, flowId } = req.body || {}
  try {
    const sets = []; const vals = []
    if (title       !== undefined) { sets.push('title=?');         vals.push(title) }
    if (description !== undefined) { sets.push('description=?');   vals.push(description) }
    if (type        !== undefined) { sets.push('type=?');          vals.push(type) }
    // Reprogramar una tarea de flujo debe darle otra oportunidad limpia: se reinician los
    // intentos y el último error, o arrastraría el fallo de la fecha anterior.
    if (dueAt       !== undefined) { sets.push('due_at=?');        vals.push(dueAt); sets.push('due_reminded_at=NULL', 'flow_runs=0', 'flow_error=NULL') }
    if (flowId      !== undefined) { sets.push('flow_id=?');       vals.push(flowId || null) }
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
    // QA del asistente: promedio de calidad + cuántos chats necesitan revisión + sin evaluar.
    let qaAvg = null, qaReviewCount = 0, qaEvaluated = 0, qaPending = 0
    try {
      const [[qa]] = await pool.query("SELECT AVG(qa_score) AS avg, COUNT(qa_score) AS n, SUM(CASE WHEN qa_score<50 THEN 1 ELSE 0 END) AS low FROM conversations WHERE account_id=? AND qa_at IS NOT NULL", [accId])
      qaAvg = qa?.avg != null ? Math.round(Number(qa.avg)) : null
      qaEvaluated = Number(qa?.n || 0); qaReviewCount = Number(qa?.low || 0)
      const [[qp]] = await pool.query("SELECT COUNT(*) AS n FROM conversations WHERE account_id=? AND ai_enabled=1 AND qa_at IS NULL", [accId])
      qaPending = Number(qp?.n || 0)
    } catch {}

    res.json({
      topics, sentiment, classifiedTotal, unclassified,
      avgFirstResponseMs, outcomes, attendedPct,
      qaAvg, qaReviewCount, qaEvaluated, qaPending,
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

// ── Métricas de asesores humanos ──────────────────────────────────────────────
// Agrupa las conversaciones por su asesor asignado (assigned_to.id) y calcula, por
// asesor y en un bucket "Sin asignar", las métricas clave de atención humana.
const advisorMetrics = async (req, res) => {
  const { accId } = req.params
  const from = Number(req.query.from) || 0
  const to   = Number(req.query.to) || Date.now()
  try {
    const [convos] = await pool.query(
      'SELECT id, assigned_to, ai_enabled, first_response_ms, archived, local_vars FROM conversations WHERE account_id=? AND created_at BETWEEN ? AND ?',
      [accId, from, to])
    const convIds = convos.map(c => c.id)
    // Mensajes enviados por asesores humanos, por conversación.
    const humanByConv = {}
    if (convIds.length) {
      const [rows] = await pool.query("SELECT conversation_id, COUNT(*) AS n FROM messages WHERE conversation_id IN (?) AND sender='human' GROUP BY conversation_id", [convIds])
      for (const r of rows) humanByConv[r.conversation_id] = Number(r.n) || 0
    }
    const [members] = await pool.query('SELECT id, name, email FROM members WHERE account_id=?', [accId])
    const nameById = {}; for (const m of members) nameById[m.id] = m.name || m.email

    const acc = {}   // por advisorId (o '_unassigned')
    const bucket = (id, name) => (acc[id] ||= { advisorId: id === '_unassigned' ? null : id, name, assigned: 0, active: 0, resolved: 0, handoffs: 0, humanMsgs: 0, frSum: 0, frCount: 0 })
    for (const c of convos) {
      const at = parseJ(c.assigned_to, null)
      const id = at?.id || '_unassigned'
      const name = at?.name || nameById[at?.id] || 'Sin asignar'
      const b = bucket(id, name)
      const lv = parseJ(c.local_vars, {})
      const closed = lv._case_status === 'closed'
      b.assigned++
      if (!closed && !c.archived) b.active++
      if (closed) b.resolved++
      if (!c.ai_enabled) b.handoffs++
      b.humanMsgs += humanByConv[c.id] || 0
      if (c.first_response_ms != null) { b.frSum += Number(c.first_response_ms) || 0; b.frCount++ }
    }
    const advisors = Object.values(acc).map(b => ({
      advisorId: b.advisorId, name: b.name,
      assigned: b.assigned, active: b.active, resolved: b.resolved,
      resolutionRate: b.assigned ? Math.round((b.resolved / b.assigned) * 100) : 0,
      handoffs: b.handoffs, humanMsgs: b.humanMsgs,
      avgFirstResponseMs: b.frCount ? Math.round(b.frSum / b.frCount) : null,
    })).sort((a, b) => b.assigned - a.assigned)
    res.json({ advisors, range: { from, to } })
  } catch (err) { console.error('[advisorMetrics]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Tareas periódicas (programaciones recurrentes) ────────────────────────────
const schedMap = r => ({
  id: r.id, title: r.title, description: r.description, type: r.type || 'general',
  priority: r.priority || 'normal', assigneeId: r.assignee_id, assigneeName: r.assignee_name,
  targetType: r.target_type, targetId: r.target_id,
  freq: r.freq || 'weekly', intervalN: r.interval_n || 1, weekday: r.weekday, monthday: r.monthday,
  nextAt: r.next_at, enabled: !!r.enabled, lastSpawnedAt: r.last_spawned_at, createdAt: r.created_at,
})

const listTaskSchedules = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM crm_task_schedules WHERE account_id=? ORDER BY created_at DESC', [req.params.accId]); res.json({ schedules: rows.map(schedMap) }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createTaskSchedule = async (req, res) => {
  const { accId } = req.params
  const b = req.body || {}
  if (!String(b.title || '').trim()) return res.status(400).json({ error: 'title requerido' })
  const id = 'sched_' + uid()
  const sched = { freq: b.freq || 'weekly', interval_n: Number(b.intervalN) || 1, weekday: b.weekday != null ? Number(b.weekday) : null, monthday: b.monthday != null ? Number(b.monthday) : null }
  const nextAt = require('../services/crmTaskSchedules').initialNextAt(sched)
  try {
    await pool.query(
      'INSERT INTO crm_task_schedules (id, account_id, title, description, type, priority, assignee_id, assignee_name, target_type, target_id, freq, interval_n, weekday, monthday, next_at, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, accId, String(b.title).slice(0, 200), b.description || '', b.type || 'general', b.priority || 'normal',
        b.assigneeId || null, b.assigneeName || '', b.targetType || null, b.targetId || null,
        sched.freq, sched.interval_n, sched.weekday, sched.monthday, nextAt, b.enabled === false ? 0 : 1, Date.now()])
    res.json({ id })
  } catch (err) { console.error('[sched create]', err); res.status(500).json({ error: 'Error interno' }) }
}

const updateTaskSchedule = async (req, res) => {
  const { accId, id } = req.params
  const b = req.body || {}
  try {
    const [[cur]] = await pool.query('SELECT * FROM crm_task_schedules WHERE id=? AND account_id=?', [id, accId])
    if (!cur) return res.status(404).json({ error: 'No encontrada' })
    const map = { title: 'title', description: 'description', type: 'type', priority: 'priority', assigneeId: 'assignee_id', assigneeName: 'assignee_name', targetType: 'target_type', targetId: 'target_id', freq: 'freq', intervalN: 'interval_n', weekday: 'weekday', monthday: 'monthday' }
    const sets = [], vals = []
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); vals.push(b[k]) }
    if (b.enabled !== undefined) { sets.push('enabled=?'); vals.push(b.enabled ? 1 : 0) }
    // Si cambió la recurrencia, recalcular next_at.
    if (['freq', 'intervalN', 'weekday', 'monthday'].some(k => b[k] !== undefined)) {
      const sched = { freq: b.freq ?? cur.freq, interval_n: b.intervalN ?? cur.interval_n, weekday: b.weekday ?? cur.weekday, monthday: b.monthday ?? cur.monthday }
      sets.push('next_at=?'); vals.push(require('../services/crmTaskSchedules').initialNextAt(sched))
    }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id, accId)
    await pool.query(`UPDATE crm_task_schedules SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteTaskSchedule = async (req, res) => {
  try { await pool.query('DELETE FROM crm_task_schedules WHERE id=? AND account_id=?', [req.params.id, req.params.accId]); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Relaciones entre tickets/deals (posiblemente de pipelines distintos) ───────
const listCardLinks = async (req, res) => {
  const { accId } = req.params
  const cardId = req.query.cardId
  if (!cardId) return res.json({ links: [] })
  try {
    const [rows] = await pool.query('SELECT * FROM crm_card_links WHERE account_id=? AND (a_card=? OR b_card=?)', [accId, cardId, cardId])
    const [pipes] = await pool.query('SELECT id, name, cards FROM pipelines WHERE account_id=?', [accId])
    const pipeName = {}, cardTitle = {}
    for (const p of pipes) { pipeName[p.id] = p.name; for (const c of parseJ(p.cards, [])) cardTitle[c.id] = c.title }
    const links = rows.map(r => {
      const isA = r.a_card === cardId
      const otherPipe = isA ? r.b_pipeline : r.a_pipeline
      const otherCard = isA ? r.b_card : r.a_card
      return { id: r.id, relation: r.relation, pipelineId: otherPipe, pipelineName: pipeName[otherPipe] || '', cardId: otherCard, title: cardTitle[otherCard] || '(tarjeta eliminada)' }
    })
    res.json({ links })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createCardLink = async (req, res) => {
  const { accId } = req.params
  const b = req.body || {}
  if (!b.aCard || !b.bCard || b.aCard === b.bCard) return res.status(400).json({ error: 'Tarjetas inválidas' })
  const rel = String(b.relation || 'relacionado').slice(0, 30)
  try {
    // Evita duplicados (mismo par en cualquier orden): actualiza la relación si ya existe.
    const [[dup]] = await pool.query('SELECT id FROM crm_card_links WHERE account_id=? AND ((a_card=? AND b_card=?) OR (a_card=? AND b_card=?)) LIMIT 1', [accId, b.aCard, b.bCard, b.bCard, b.aCard])
    if (dup) { await pool.query('UPDATE crm_card_links SET relation=? WHERE id=?', [rel, dup.id]); return res.json({ id: dup.id }) }
    const id = 'link_' + uid()
    await pool.query('INSERT INTO crm_card_links (id, account_id, a_pipeline, a_card, b_pipeline, b_card, relation, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, accId, b.aPipeline || null, b.aCard, b.bPipeline || null, b.bCard, rel, Date.now()])
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteCardLink = async (req, res) => {
  try { await pool.query('DELETE FROM crm_card_links WHERE id=? AND account_id=?', [req.params.id, req.params.accId]); res.json({ ok: true }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Acción de ticket (deal de pipeline o tarea CRM) sobre una conversación. La usan el
// nodo de flujo del NAVEGADOR (webchat/test) y el inbox; el motor backend llama al
// servicio directamente. Misma lógica compartida: services/tickets.js.
const ticketAction = async (req, res) => {
  const { accId } = req.params
  const { convId, ...opts } = req.body || {}
  if (!convId) return res.status(400).json({ error: 'Falta convId' })
  try {
    const r = await require('../services/tickets').applyTicketAction(accId, convId, opts)
    res.json(r)
  } catch (err) { res.status(400).json({ error: err.message || 'No se pudo aplicar la acción' }) }
}

// Proxy de la HERRAMIENTA IA de ticket para el motor del NAVEGADOR (webchat sin sesión).
// Deliberadamente más estrecho que `ticketAction`:
//   · solo `deal` (nunca tareas) y solo crear/mover,
//   · el pipeline se resuelve por NOMBRE contra los pipelines MARCADOS para la IA, así que
//     no se puede tocar uno no habilitado,
//   · `applyTicketAction` solo actúa sobre la tarjeta vinculada a ESA conversación.
const ticketTool = async (req, res) => {
  const { accId } = req.params
  const { convId, accion, pipeline, etapa, titulo, valor } = req.body || {}
  if (!convId) return res.status(400).json({ error: 'Falta convId' })
  try {
    const [rows] = await pool.query('SELECT id, name, stages FROM pipelines WHERE account_id=? AND ai_enabled=1', [accId])
    const pipes = rows.map(p => ({
      id: p.id, name: p.name,
      stages: [...parseJ(p.stages, [])].sort((a, b) => (a.order || 0) - (b.order || 0)).map(s => ({ id: s.id, name: s.name })),
    }))
    const { resolvePipelineTarget } = require('../flow/nodes/ai')
    const r = resolvePipelineTarget(pipes, pipeline, etapa)
    if (r.error) return res.json({ text: r.error })
    const out = await require('../services/tickets').applyTicketAction(accId, convId, {
      tipo: 'deal',
      accion: accion === 'crear' ? 'crear' : 'mover',
      pipelineId: r.pipe.id, stageId: r.stage?.id || null,
      title: titulo || '', value: valor || '',
    })
    res.json({
      ok: true, ...out,
      text: accion === 'crear'
        ? `Ticket creado en "${r.pipe.name}"${r.stage ? `, etapa "${r.stage.name}"` : ''}.`
        : `Ticket movido a "${r.stage?.name || '?'}" en "${r.pipe.name}".`,
    })
  } catch (err) { res.json({ text: `No se pudo gestionar el ticket: ${err.message}` }) }
}

// Proxy de la HERRAMIENTA IA de tareas para el motor del NAVEGADOR (webchat sin sesión).
// Igual de estrecho que `ticketTool`: solo crea UNA tarea ligada a la conversación indicada,
// con la misma lógica de asignación y fecha que usa el motor del servidor.
const taskTool = async (req, res) => {
  const { accId } = req.params
  const { convId, ...args } = req.body || {}
  if (!convId) return res.status(400).json({ error: 'Falta convId' })
  try {
    const [[acc]] = await pool.query('SELECT ai_timezone FROM accounts WHERE id=?', [accId])
    const out = await require('../services/aiTasks').createAiTask(accId, convId, args, { timezone: acc?.ai_timezone || 'America/Bogota' })
    res.json(out)
  } catch (err) { res.json({ text: `No se pudo crear la tarea: ${err.message}` }) }
}

module.exports = { listNotes, createNote, deleteNote, listTasks, createTask, updateTask, deleteTask, listActivity, kpis, logActivity, classifyConversations, previewExecutiveSummary, sendExecutiveSummary, pipelineVelocity, retention, copilotAsk, platformAsk, detectOpportunities, leadScores, qaRun, qaReview,
  listTaskSchedules, createTaskSchedule, updateTaskSchedule, deleteTaskSchedule, listCardLinks, createCardLink, deleteCardLink, advisorMetrics, ticketAction, ticketTool, taskTool }
