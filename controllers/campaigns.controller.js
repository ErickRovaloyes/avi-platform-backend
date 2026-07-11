'use strict'
const pool = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')
const campaigns = require('../services/campaigns')

const mapCampaign = c => ({
  id: c.id, agentId: c.agent_id, name: c.name, channel: c.channel,
  flowId: c.flow_id, audience: parseJ(c.audience, {}),
  scheduledAt: c.scheduled_at, status: c.status, stats: parseJ(c.stats, null),
  sentAt: c.sent_at, createdAt: c.created_at,
  variantFlowId: c.variant_flow_id || null, abSplit: c.ab_split || null,
  hasAb: !!c.variant_flow_id,
})

const list = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM campaigns WHERE account_id=? ORDER BY created_at DESC', [accId])
    res.json(rows.map(mapCampaign))
  } catch (err) { console.error('[campaigns list]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Vista previa del tamaño de la audiencia para un filtro dado.
const preview = async (req, res) => {
  const { accId } = req.params
  try { res.json({ count: await campaigns.audienceCount(accId, req.body?.audience || {}) }) }
  catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const { name, agentId, flowId, channel = 'whatsapp', audience = {}, scheduledAt = null, variantFlowId = null, abSplit = null } = req.body || {}
  if (!name || !flowId || !agentId) return res.status(400).json({ error: 'Nombre, agente y flujo son obligatorios' })
  const id = 'camp_' + uid()
  const status = scheduledAt ? 'scheduled' : 'draft'
  const vFlow = variantFlowId && variantFlowId !== flowId ? variantFlowId : null
  const split = vFlow ? Math.min(Math.max(parseInt(abSplit) || 50, 5), 95) : null
  try {
    await pool.query(
      'INSERT INTO campaigns (id,account_id,agent_id,name,channel,flow_id,audience,scheduled_at,status,created_at,variant_flow_id,ab_split) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, accId, agentId, name, channel, flowId, JSON.stringify(audience || {}), scheduledAt || null, status, Date.now(), vFlow, split]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id, status })
  } catch (err) { console.error('[campaigns create]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Enviar ya (no bloquea: corre en segundo plano).
const sendNow = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[c]] = await pool.query('SELECT status FROM campaigns WHERE id=? AND account_id=?', [id, accId])
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' })
    if (['sending', 'done'].includes(c.status)) return res.status(409).json({ error: 'La campaña ya se está enviando o ya terminó' })
    campaigns.runCampaign(id).then(() => socket.emit(accId, 'account:updated', { accId })).catch(e => console.warn('[sendNow]', e.message))
    res.json({ ok: true, started: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Editar una campaña que aún NO se ha enviado (borrador o programada).
const update = async (req, res) => {
  const { accId, id } = req.params
  const { name, flowId, audience, scheduledAt, variantFlowId, abSplit } = req.body || {}
  try {
    const [[c]] = await pool.query('SELECT status, flow_id FROM campaigns WHERE id=? AND account_id=?', [id, accId])
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' })
    if (!['draft', 'scheduled'].includes(c.status)) {
      return res.status(409).json({ error: 'Solo se pueden editar campañas en borrador o programadas' })
    }
    const sets = [], vals = []
    if (name !== undefined)     { sets.push('name=?');         vals.push(name) }
    if (flowId !== undefined)   { sets.push('flow_id=?');      vals.push(flowId) }
    if (audience !== undefined) { sets.push('audience=?');     vals.push(JSON.stringify(audience || {})) }
    if (variantFlowId !== undefined) {
      const baseFlow = flowId !== undefined ? flowId : c.flow_id
      const vFlow = variantFlowId && variantFlowId !== baseFlow ? variantFlowId : null
      sets.push('variant_flow_id=?'); vals.push(vFlow)
      sets.push('ab_split=?');        vals.push(vFlow ? Math.min(Math.max(parseInt(abSplit) || 50, 5), 95) : null)
    }
    if (scheduledAt !== undefined) {
      sets.push('scheduled_at=?'); vals.push(scheduledAt || null)
      sets.push('status=?');       vals.push(scheduledAt ? 'scheduled' : 'draft')
    }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id, accId)
    await pool.query(`UPDATE campaigns SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { console.error('[campaigns update]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Reenviar: clona la campaña como una nueva y la envía de inmediato (conserva el historial).
const resend = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[c]] = await pool.query('SELECT * FROM campaigns WHERE id=? AND account_id=?', [id, accId])
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' })
    const newId = 'camp_' + uid()
    const newName = /\(reenv/i.test(c.name || '') ? c.name : `${c.name} (reenvío)`
    await pool.query(
      'INSERT INTO campaigns (id,account_id,agent_id,name,channel,flow_id,audience,scheduled_at,status,created_at,variant_flow_id,ab_split) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [newId, accId, c.agent_id, newName, c.channel, c.flow_id, c.audience, null, 'sending', Date.now(), c.variant_flow_id || null, c.ab_split || null]
    )
    campaigns.runCampaign(newId).then(() => socket.emit(accId, 'account:updated', { accId })).catch(e => console.warn('[resend]', e.message))
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true, id: newId, started: true })
  } catch (err) { console.error('[campaigns resend]', err); res.status(500).json({ error: 'Error interno' }) }
}

const cancel = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query("UPDATE campaigns SET status='cancelled' WHERE id=? AND account_id=? AND status IN ('draft','scheduled')", [id, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query('DELETE FROM campaigns WHERE id=? AND account_id=?', [id, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ROI / atribución: ingresos de los destinatarios en los N días posteriores al envío.
const roi = async (req, res) => {
  const { accId, id } = req.params
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90)
  try {
    const [[c]] = await pool.query('SELECT * FROM campaigns WHERE id=? AND account_id=?', [id, accId])
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' })
    let recipients = parseJ(c.recipients, [])
    if (!recipients.length) { try { recipients = (await campaigns.resolveAudience(accId, parseJ(c.audience, {}))).map(x => x.id).filter(Boolean) } catch {} }
    const sentAt = c.sent_at || c.created_at
    if (!recipients.length || !sentAt) return res.json({ orders: 0, revenue: 0, currency: 'COP', days, recipients: recipients.length, convRate: 0 })
    const until = sentAt + days * 86400000
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS rev, MAX(currency) AS cur FROM orders
       WHERE account_id=? AND contact_id IN (?) AND status NOT IN('draft','canceled') AND created_at BETWEEN ? AND ?`,
      [accId, recipients, sentAt, until])
    const orders = Number(rows[0]?.n || 0), revenue = Number(rows[0]?.rev || 0)
    res.json({ orders, revenue: Math.round(revenue), currency: rows[0]?.cur || 'COP', days, recipients: recipients.length, convRate: recipients.length ? Math.round(orders / recipients.length * 100) : 0 })
  } catch (err) { console.error('[campaign roi]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Resultados A/B: compara los dos grupos por respuesta y por conversión (pedidos).
const abResults = async (req, res) => {
  const { accId, id } = req.params
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90)
  try {
    const [[c]] = await pool.query('SELECT * FROM campaigns WHERE id=? AND account_id=?', [id, accId])
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' })
    if (!c.variant_flow_id) return res.json({ ab: false })
    const groups = parseJ(c.ab_groups, null)
    const sentAt = c.sent_at || c.created_at
    async function measure(g) {
      const contacts = (g?.contacts || []).filter(Boolean)
      const convos = (g?.convos || []).filter(Boolean)
      const recipients = convos.length || contacts.length
      // Respondieron: conversaciones con un mensaje entrante posterior al envío.
      let responded = 0
      if (convos.length) {
        const [[r]] = await pool.query(
          "SELECT COUNT(DISTINCT conversation_id) AS n FROM messages WHERE conversation_id IN (?) AND sender='user' AND ts>?",
          [convos, sentAt || 0])
        responded = Number(r?.n || 0)
      }
      // Conversión: pedidos de esos contactos en la ventana posterior.
      let orders = 0, revenue = 0, currency = 'COP'
      if (contacts.length && sentAt) {
        const [[o]] = await pool.query(
          `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS rev, MAX(currency) AS cur FROM orders
           WHERE account_id=? AND contact_id IN (?) AND status NOT IN('draft','canceled') AND created_at BETWEEN ? AND ?`,
          [accId, contacts, sentAt, sentAt + days * 86400000])
        orders = Number(o?.n || 0); revenue = Math.round(Number(o?.rev || 0)); currency = o?.cur || 'COP'
      }
      return {
        recipients, responded, orders, revenue, currency,
        replyRate: recipients ? Math.round(responded / recipients * 100) : 0,
        convRate: recipients ? Math.round(orders / recipients * 100) : 0,
      }
    }
    const a = await measure(groups?.a), b = await measure(groups?.b)
    // Ganador por tasa de respuesta (señal directa del mensaje); desempate por ingresos.
    let winner = null
    if (a.recipients && b.recipients) {
      if (a.replyRate !== b.replyRate) winner = a.replyRate > b.replyRate ? 'a' : 'b'
      else if (a.revenue !== b.revenue) winner = a.revenue > b.revenue ? 'a' : 'b'
      else winner = 'tie'
    }
    res.json({ ab: true, days, split: c.ab_split || 50, a, b, winner })
  } catch (err) { console.error('[campaign ab]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Mejor hora de envío: mapa de calor de actividad entrante del cliente (día×hora).
const bestTime = async (req, res) => {
  const { accId } = req.params
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 7), 365)
  const tzOffset = parseInt(req.query.tzOffset) // minutos que devuelve JS getTimezoneOffset (UTC-local)
  const off = Number.isFinite(tzOffset) ? tzOffset : 300 // por defecto America/Bogota (UTC-5)
  try {
    const since = Date.now() - days * 86400000
    const [rows] = await pool.query(
      `SELECT m.ts FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE c.account_id=? AND m.sender='user' AND m.ts>=?`, [accId, since])
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0)) // [weekday][hour]
    const byHour = new Array(24).fill(0)
    const byDay = new Array(7).fill(0)
    let total = 0
    for (const r of rows) {
      const local = Number(r.ts) - off * 60000
      const d = new Date(local)
      const wd = d.getUTCDay(), hr = d.getUTCHours()
      grid[wd][hr]++; byHour[hr]++; byDay[wd]++; total++
    }
    // Recomendación: mejor celda día×hora + mejor franja horaria (ventana de 2h) + mejor día.
    let best = { wd: 0, hr: 0, n: -1 }
    for (let wd = 0; wd < 7; wd++) for (let hr = 0; hr < 24; hr++) if (grid[wd][hr] > best.n) best = { wd, hr, n: grid[wd][hr] }
    let bestWindow = { hr: 0, n: -1 }
    for (let hr = 0; hr < 24; hr++) { const w = byHour[hr] + byHour[(hr + 1) % 24]; if (w > bestWindow.n) bestWindow = { hr, n: w } }
    const bestDay = byDay.indexOf(Math.max(...byDay))
    res.json({ total, days, grid, byHour, byDay, best, bestWindow, bestDay })
  } catch (err) { console.error('[campaign best-time]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, preview, create, sendNow, update, resend, cancel, remove, roi, abResults, bestTime }
