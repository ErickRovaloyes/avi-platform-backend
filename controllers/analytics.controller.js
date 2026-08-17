'use strict'
const pool = require('../db')
const { parseJ } = require('../utils')

// ── Pricing cache ───────────────────────────────────────────────────────────

let _pricingCache = null
let _pricingCacheTs = 0
const PRICING_CACHE_MS = 60_000

async function getPricingMap() {
  const now = Date.now()
  if (_pricingCache && now - _pricingCacheTs < PRICING_CACHE_MS) return _pricingCache
  const [rows] = await pool.query('SELECT * FROM model_pricing')
  _pricingCache = {}
  for (const r of rows) {
    _pricingCache[r.model] = {
      provider: r.provider,
      inputPer1k: Number(r.input_per_1k),
      outputPer1k: Number(r.output_per_1k),
      displayName: r.display_name,
    }
  }
  _pricingCacheTs = now
  return _pricingCache
}

function computeCost(model, promptTokens, completionTokens, pricing) {
  const p = pricing[model]
  if (!p) return 0
  return ((promptTokens || 0) * p.inputPer1k / 1000) + ((completionTokens || 0) * p.outputPer1k / 1000)
}

// ── Token usage: record and query ──────────────────────────────────────────

const recordUsage = async (req, res) => {
  const { accId } = req.params
  const {
    agentId = null, conversationId = null,
    provider = '', model = '',
    promptTokens = 0, completionTokens = 0,
    source = 'chat',
  } = req.body || {}
  try {
    const total = (promptTokens || 0) + (completionTokens || 0)
    if (total === 0) return res.json({ ok: true, skipped: true })
    const pricing = await getPricingMap()
    const cost = computeCost(model, promptTokens, completionTokens, pricing)
    const ts = Date.now()
    await pool.query(
      `INSERT INTO token_usage (account_id, agent_id, conversation_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, source, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [accId, agentId, conversationId, provider, model, promptTokens || 0, completionTokens || 0, total, cost, source, ts]
    )
    res.json({ ok: true, cost, totalTokens: total })
  } catch (err) {
    console.error('[RECORD USAGE]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

// Server-side helper: callable from other controllers (no HTTP roundtrip)
async function recordUsageInternal({ accId, agentId, conversationId, provider, model, promptTokens, completionTokens, source }) {
  if (!accId || !model) return
  try {
    const total = (promptTokens || 0) + (completionTokens || 0)
    if (total === 0) return
    const pricing = await getPricingMap()
    const cost = computeCost(model, promptTokens, completionTokens, pricing)
    await pool.query(
      `INSERT INTO token_usage (account_id, agent_id, conversation_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, source, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [accId, agentId || null, conversationId || null, provider || '', model, promptTokens || 0, completionTokens || 0, total, cost, source || 'chat', Date.now()]
    )
  } catch (e) { console.warn('[RECORD USAGE INTERNAL]', e.message) }
}

// GET /api/accounts/:accId/token-usage?from=ts&to=ts&agentId=&model=&groupBy=model|day|agent
const queryUsage = async (req, res) => {
  const { accId } = req.params
  const { from = 0, to = Date.now(), agentId, model, groupBy = 'model' } = req.query
  const fromMs = parseInt(from) || 0
  const toMs   = parseInt(to)   || Date.now()
  try {
    const where = ['account_id=?', 'ts BETWEEN ? AND ?']
    const params = [accId, fromMs, toMs]
    if (agentId) { where.push('agent_id=?'); params.push(agentId) }
    if (model)   { where.push('model=?');    params.push(model) }
    const whereSql = 'WHERE ' + where.join(' AND ')

    // Totals
    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS count_calls,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM token_usage ${whereSql}`,
      params
    )

    // Grouped breakdown
    let groupSql, groupKey
    if (groupBy === 'day') {
      groupSql = `DATE(FROM_UNIXTIME(ts/1000)) AS bucket`
      groupKey = 'bucket'
    } else if (groupBy === 'agent') {
      groupSql = `agent_id AS bucket`
      groupKey = 'bucket'
    } else if (groupBy === 'source') {
      groupSql = `source AS bucket`
      groupKey = 'bucket'
    } else {
      groupSql = `model AS bucket, provider`
      groupKey = 'bucket'
    }

    const [rows] = await pool.query(
      `SELECT ${groupSql},
              COUNT(*) AS count_calls,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM token_usage ${whereSql}
       GROUP BY ${groupBy === 'model' ? 'model, provider' : 'bucket'}
       ORDER BY total_tokens DESC
       LIMIT 1000`,
      params
    )

    // Daily trend separately so the UI can always draw a chart
    const [trend] = await pool.query(
      `SELECT DATE(FROM_UNIXTIME(ts/1000)) AS day,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM token_usage ${whereSql}
       GROUP BY day ORDER BY day ASC LIMIT 90`,
      params
    )

    res.json({
      totals: {
        countCalls: Number(totals.count_calls),
        promptTokens: Number(totals.prompt_tokens),
        completionTokens: Number(totals.completion_tokens),
        totalTokens: Number(totals.total_tokens),
        costUsd: Number(totals.cost_usd),
      },
      groupBy,
      groups: rows.map(r => ({
        key: r[groupKey],
        provider: r.provider,
        countCalls: Number(r.count_calls),
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        totalTokens: Number(r.total_tokens),
        costUsd: Number(r.cost_usd),
      })),
      dailyTrend: trend.map(r => ({
        day: r.day,
        totalTokens: Number(r.total_tokens),
        costUsd: Number(r.cost_usd),
      })),
    })
  } catch (err) {
    console.error('[QUERY USAGE]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

// ── Model pricing CRUD ─────────────────────────────────────────────────────

const listPricing = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM model_pricing ORDER BY provider, model')
    res.json(rows.map(r => ({
      model: r.model,
      provider: r.provider,
      inputPer1k: Number(r.input_per_1k),
      outputPer1k: Number(r.output_per_1k),
      displayName: r.display_name,
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updatePricing = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { model } = req.params
  const { inputPer1k, outputPer1k, displayName, provider } = req.body
  try {
    await pool.query(
      `INSERT INTO model_pricing (model, provider, input_per_1k, output_per_1k, display_name)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         provider      = COALESCE(VALUES(provider),      provider),
         input_per_1k  = COALESCE(VALUES(input_per_1k),  input_per_1k),
         output_per_1k = COALESCE(VALUES(output_per_1k), output_per_1k),
         display_name  = COALESCE(VALUES(display_name),  display_name)`,
      [model, provider || null, inputPer1k, outputPer1k, displayName || model]
    )
    _pricingCache = null
    res.json({ ok: true })
  } catch (err) {
    console.error('[UPDATE PRICING]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

const deletePricing = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    await pool.query('DELETE FROM model_pricing WHERE model=?', [req.params.model])
    _pricingCache = null
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Business metrics ────────────────────────────────────────────────────────

// GET /api/accounts/:accId/metrics?from=ts&to=ts&agentId=
const businessMetrics = async (req, res) => {
  const { accId } = req.params
  const { from = 0, to = Date.now(), agentId } = req.query
  const fromMs = parseInt(from) || (Date.now() - 30 * 86_400_000)
  const toMs   = parseInt(to)   || Date.now()

  try {
    // ── Conversations within range ────────────────────────────────────────
    const convWhere = ['c.account_id=?', 'c.created_at BETWEEN ? AND ?']
    const convParams = [accId, fromMs, toMs]
    if (agentId) { convWhere.push('c.agent_id=?'); convParams.push(agentId) }
    const convWhereSql = 'WHERE ' + convWhere.join(' AND ')

    const [convRows] = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS msg_count
       FROM conversations c ${convWhereSql}`,
      convParams
    )

    // ── Messages in range (for response time calc) ────────────────────────
    const [msgRows] = await pool.query(
      `SELECT m.conversation_id, m.sender, m.ts, m.id
       FROM messages m JOIN conversations c ON m.conversation_id = c.id
       ${convWhereSql.replace(/c\.created_at/g, 'm.ts')}
       ORDER BY m.conversation_id, m.ts`,
      convParams
    )

    // ── KPIs ─────────────────────────────────────────────────────────────
    const totalConversations = convRows.length
    const totalMessages = convRows.reduce((s, c) => s + Number(c.msg_count || 0), 0)
    const handedOff = convRows.filter(c => c.ai_enabled === 0).length
    const humanHandoffPct = totalConversations > 0 ? (handedOff / totalConversations * 100) : 0

    // Tiempo de respuesta: del mensaje del cliente al siguiente del negocio.
    //
    // Antes salía UN solo número que mezclaba IA y asesor, y eso no dice nada útil: la IA
    // contesta en segundos y una persona puede tardar horas, así que el promedio conjunto no
    // describe a ninguno de los dos. Se cuentan por separado.
    const byConv = {}
    for (const m of msgRows) {
      if (!byConv[m.conversation_id]) byConv[m.conversation_id] = []
      byConv[m.conversation_id].push(m)
    }
    const acum = { ai: { n: 0, suma: 0 }, human: { n: 0, suma: 0 } }
    for (const convId in byConv) {
      const msgs = byConv[convId]
      for (let i = 0; i < msgs.length - 1; i++) {
        const quien = msgs[i + 1].sender
        if (msgs[i].sender === 'user' && (quien === 'ai' || quien === 'human')) {
          acum[quien].suma += Number(msgs[i + 1].ts) - Number(msgs[i].ts)
          acum[quien].n++
        }
      }
    }
    const media = a => (a.n ? Math.round(a.suma / a.n) : 0)
    const avgResponseTimeAiMs    = media(acum.ai)
    const avgResponseTimeHumanMs = media(acum.human)
    // Se mantiene el combinado: hay pantallas que ya lo pintan.
    const totalResp = acum.ai.n + acum.human.n
    const avgResponseTimeMs = totalResp ? Math.round((acum.ai.suma + acum.human.suma) / totalResp) : 0

    // ── Métricas de negocio ──────────────────────────────────────────────
    // Cada consulta va protegida por su cuenta: estas tablas las crea el módulo que las usa
    // (agendas, CRM, pedidos), así que una cuenta sin ese módulo no las tiene. Que falte una
    // no puede tumbar el panel entero — se informa 0 y las demás siguen.
    const contar = async (sql, params) => {
      try { const [[r]] = await pool.query(sql, params); return Number(r?.n) || 0 }
      catch { return null }   // null = la métrica no aplica en esta cuenta
    }
    const rango = [accId, fromMs, toMs]

    // Citas agendadas: todo lo reservado en agendas, sin contar lo cancelado.
    const appointments = await contar(
      "SELECT COUNT(*) AS n FROM calendar_bookings WHERE account_id=? AND created_at BETWEEN ? AND ? AND (status IS NULL OR status NOT IN ('cancelled','canceled'))", rango)

    // Reservas: las citas que además ocupan un recurso (habitación, mesa) — el caso de hotel
    // y restaurante. Es lo que las distingue de una cita normal.
    const reservations = await contar(
      `SELECT COUNT(DISTINCT b.id) AS n FROM calendar_bookings b
         JOIN booking_allocations a ON a.booking_id = b.id
        WHERE b.account_id=? AND b.created_at BETWEEN ? AND ?
          AND (b.status IS NULL OR b.status NOT IN ('cancelled','canceled'))`, rango)

    // Seguimientos: tareas de CRM creadas en el periodo.
    const followupTasks = await contar(
      'SELECT COUNT(*) AS n FROM crm_tasks WHERE account_id=? AND created_at BETWEEN ? AND ?', rango)
    // Y los chats marcados a mano con la estrella de seguimiento.
    const followupChats = convRows.filter(c => c.followup).length

    // Pedidos pagados o entregados: es la conversión de verdad, no una intención.
    const ordersWon = await contar(
      "SELECT COUNT(*) AS n FROM orders WHERE account_id=? AND created_at BETWEEN ? AND ? AND status IN ('paid','delivered')", rango)

    // Oportunidades: conversaciones que llegaron a tener tarjeta en algún pipeline.
    const opportunities = convRows.filter(c => (parseJ(c.pipeline_cards, []) || []).length > 0).length

    // Consultas calificadas: el clasificador les vio intención de compra alta o media.
    const qualifiedLeads = convRows.filter(c => c.buying_intent === 'alta' || c.buying_intent === 'media').length

    // Tasa de conversión sobre las conversaciones del periodo. Se prefiere el pedido real; si
    // la cuenta no vende por pedidos (hotel, servicios), se usa la cita/reserva conseguida.
    const convertidas = ordersWon != null && ordersWon > 0
      ? ordersWon
      : (appointments || 0)
    const conversionRate = totalConversations > 0 ? (convertidas / totalConversations * 100) : 0

    // ── Conversations by channel ─────────────────────────────────────────
    const channelMap = {}
    for (const c of convRows) {
      const ch = c.channel_type || 'webchat'
      channelMap[ch] = (channelMap[ch] || 0) + 1
    }
    const conversationsByChannel = Object.entries(channelMap).map(([channel, count]) => ({ channel, count }))

    // ── Daily trend (conversations + messages per day) ───────────────────
    const dayMap = {}
    for (const c of convRows) {
      const day = new Date(Number(c.created_at)).toISOString().slice(0, 10)
      if (!dayMap[day]) dayMap[day] = { day, conversations: 0, messages: 0 }
      dayMap[day].conversations += 1
      dayMap[day].messages += Number(c.msg_count || 0)
    }
    const dailyTrend = Object.values(dayMap).sort((a, b) => a.day.localeCompare(b.day))

    // ── Hourly heatmap (24h x 7d) ────────────────────────────────────────
    const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0))
    for (const m of msgRows) {
      const d = new Date(Number(m.ts))
      const dow = d.getDay() // 0=Sun
      const hour = d.getHours()
      heatmap[dow][hour] += 1
    }

    // ── Top labels ───────────────────────────────────────────────────────
    const labelCount = {}
    for (const c of convRows) {
      const labels = parseJ(c.labels, [])
      for (const l of labels) labelCount[l] = (labelCount[l] || 0) + 1
    }
    const [labelDefs] = await pool.query('SELECT id, name, color FROM labels WHERE account_id=?', [accId])
    const labelById = Object.fromEntries(labelDefs.map(l => [l.id, l]))
    const topLabels = Object.entries(labelCount)
      .map(([id, count]) => ({ id, count, name: labelById[id]?.name || id, color: labelById[id]?.color }))
      .sort((a, b) => b.count - a.count).slice(0, 10)

    // ── Conversations by agent ───────────────────────────────────────────
    const agentCount = {}
    for (const c of convRows) agentCount[c.agent_id] = (agentCount[c.agent_id] || 0) + 1
    const [agents] = await pool.query('SELECT id, name FROM agents WHERE account_id=?', [accId])
    const agentById = Object.fromEntries(agents.map(a => [a.id, a.name]))
    const conversationsByAgent = Object.entries(agentCount)
      .map(([id, count]) => ({ agentId: id, name: agentById[id] || id, count }))
      .sort((a, b) => b.count - a.count)

    // ── Pipeline funnel (cards per stage, across all pipelines of account) ─
    const [pipelines] = await pool.query('SELECT id, name, stages, cards FROM pipelines WHERE account_id=?', [accId])
    const pipelineFunnel = []
    for (const p of pipelines) {
      const stages = parseJ(p.stages, [])
      const cards  = parseJ(p.cards, [])
      for (const stage of stages) {
        const count = cards.filter(c => c.stageId === stage.id).length
        pipelineFunnel.push({ pipelineId: p.id, pipelineName: p.name, stageId: stage.id, stageName: stage.name, color: stage.color, count })
      }
    }

    // ── Token usage breakdown ────────────────────────────────────────────
    const tokenWhere = ['account_id=?', 'ts BETWEEN ? AND ?']
    const tokenParams = [accId, fromMs, toMs]
    if (agentId) { tokenWhere.push('agent_id=?'); tokenParams.push(agentId) }
    const tokenWhereSql = 'WHERE ' + tokenWhere.join(' AND ')
    const [[tokenTotals]] = await pool.query(
      `SELECT COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(cost_usd),0) AS c FROM token_usage ${tokenWhereSql}`,
      tokenParams
    )
    const [tokenByModel] = await pool.query(
      `SELECT model, COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(cost_usd),0) AS c
       FROM token_usage ${tokenWhereSql} GROUP BY model ORDER BY t DESC`,
      tokenParams
    )

    res.json({
      range: { from: fromMs, to: toMs },
      kpis: {
        totalConversations,
        totalMessages,
        humanHandoffPct: Math.round(humanHandoffPct * 10) / 10,
        avgResponseTimeMs,
        // Separados: el promedio conjunto no describía ni a la IA ni al asesor.
        avgResponseTimeAiMs,
        avgResponseTimeHumanMs,
        // Negocio. `null` = la cuenta no tiene ese módulo, y se distingue de un 0 real.
        appointments,
        reservations,
        followupTasks,
        followupChats,
        opportunities,
        qualifiedLeads,
        ordersWon,
        conversionRate: Math.round(conversionRate * 10) / 10,
        totalTokens: Number(tokenTotals.t),
        totalCostUsd: Number(tokenTotals.c),
      },
      conversationsByChannel,
      dailyTrend,
      heatmap, // [dayOfWeek][hour] = count
      topLabels,
      conversationsByAgent,
      pipelineFunnel,
      tokenByModel: tokenByModel.map(r => ({ model: r.model, totalTokens: Number(r.t), costUsd: Number(r.c) })),
    })
  } catch (err) {
    console.error('[BUSINESS METRICS]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

module.exports = {
  recordUsage, recordUsageInternal, queryUsage,
  listPricing, updatePricing, deletePricing,
  businessMetrics,
  getPricingMap, computeCost,
}
