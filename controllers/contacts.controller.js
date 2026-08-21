'use strict'
const pool = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

const mapContact = c => ({
  id: c.id, name: c.name, email: c.email, phone: c.phone,
  createdAt: c.created_at,
  ...parseJ(c.extra, {}),
})

const list = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM contacts WHERE account_id=? ORDER BY created_at DESC', [accId])
    res.json(rows.map(mapContact))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const getOne = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[row]] = await pool.query('SELECT * FROM contacts WHERE id=? AND account_id=?', [id, accId])
    if (!row) return res.status(404).json({ error: 'Contacto no encontrado' })
    res.json(mapContact(row))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const { id, name = '', email = '', phone = '', ...extra } = req.body || {}
  const finalId = id || 'contact_' + uid()
  try {
    await pool.query(
      'INSERT INTO contacts (id, account_id, name, email, phone, extra, created_at) VALUES (?,?,?,?,?,?,?)',
      [finalId, accId, name, email, phone, JSON.stringify(extra || {}), Date.now()]
    )
    res.json({ id: finalId })
  } catch (err) { console.error('[CREATE CONTACT]', err); res.status(500).json({ error: err.message }) }
}

const update = async (req, res) => {
  const { accId, id } = req.params
  const { name, email, phone, ...extra } = req.body || {}
  try {
    const sets = []; const vals = []
    if (name  !== undefined) { sets.push('name=?');  vals.push(name) }
    if (email !== undefined) { sets.push('email=?'); vals.push(email) }
    if (phone !== undefined) { sets.push('phone=?'); vals.push(phone) }
    if (Object.keys(extra).length) {
      const [[row]] = await pool.query('SELECT extra FROM contacts WHERE id=? AND account_id=?', [id, accId])
      const merged = { ...parseJ(row?.extra, {}), ...extra }
      sets.push('extra=?'); vals.push(JSON.stringify(merged))
    }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id, accId)
    await pool.query(`UPDATE contacts SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    // Coherencia del lead: refleja el cambio en las conversaciones del contacto (nombre
    // visible del chat + variables ancladas). Best-effort; no bloquea la respuesta.
    try {
      await require('../services/contactSync').syncConversationsFromContact(accId, id, { name, phone, email })
      require('../services/socket').emit(accId, 'convos:updated', { accId })
    } catch { /* non-critical */ }
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Borrar el contacto se lo lleva TODO: sus chats, su memoria y su rastro en el CRM. El mismo
// servicio que usa «eliminar conversación», para que las dos puertas acaben en el mismo sitio;
// aquí antes se borraban los chats pero quedaban vivas sus notas, tareas y tarjetas.
const remove = async (req, res) => {
  const { accId, id } = req.params
  try {
    const r = await require('../services/contactPurge').purgeContact(accId, id)
    r.agentes.forEach(agId => socket.emit(accId, 'convos:updated', { accId, agId }))
    res.json({ ok: true, deletedConversations: r.conversaciones.length })
  } catch (err) { console.error('[DELETE CONTACT]', err); res.status(500).json({ error: 'Error interno' }) }
}

const listConversations = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [rows] = await pool.query(
      `SELECT id, agent_id, channel_type, guest_name, preview, topic, sentiment, created_at, updated_at
       FROM conversations
       WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars, '$.contact_id'))=?
       ORDER BY updated_at DESC
       LIMIT 50`,
      [accId, id]
    )
    res.json(rows.map(c => ({
      id: c.id, agentId: c.agent_id, channel: c.channel_type,
      guestName: c.guest_name, preview: c.preview, topic: c.topic || null, sentiment: c.sentiment || null,
      createdAt: c.created_at, updatedAt: c.updated_at,
    })))
  } catch (err) {
    console.error('[CONTACT CONVOS]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// ── Ficha 360°: perfil + métricas derivadas + línea de tiempo unificada ──────────
// Reúne en un solo lugar todo lo del cliente: chats, pedidos, reservas, notas y tareas.
const profile360 = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[c]] = await pool.query('SELECT * FROM contacts WHERE id=? AND account_id=?', [id, accId])
    if (!c) return res.status(404).json({ error: 'Contacto no encontrado' })
    const contact = mapContact(c)
    const phone = c.phone || ''

    const [convos] = await pool.query(
      `SELECT id, agent_id, channel_type, preview, ai_enabled, topic, sentiment, pipeline_cards, created_at, updated_at
       FROM conversations WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars,'$.contact_id'))=?
       ORDER BY created_at DESC LIMIT 100`, [accId, id])

    // ── Tickets (tarjetas de pipeline) del contacto ───────────────────────────
    // No hay un id de contacto en las tarjetas históricas: `card.contact` es solo un nombre,
    // y fiarse del nombre mezclaría homónimos. Se usan tres vías DURAS y se unen por card.id:
    //   ① los enlaces conversación→tarjeta (`conversations.pipeline_cards`),
    //   ② `card.convId` apuntando a una conversación de este contacto,
    //   ③ `card.contactId`, que se guarda en las tarjetas nuevas desde ahora.
    const convIds = new Set(convos.map(x => x.id))
    const linkedCardIds = new Set()
    for (const cv of convos) for (const l of parseJ(cv.pipeline_cards, [])) if (l?.cardId) linkedCardIds.add(l.cardId)

    let deals = []
    try {
      const [pipes] = await pool.query('SELECT id, name, stages, cards FROM pipelines WHERE account_id=?', [accId])
      for (const p of pipes) {
        const stages = parseJ(p.stages, [])
        for (const card of parseJ(p.cards, [])) {
          if (!card?.id) continue
          if (!(linkedCardIds.has(card.id) || (card.convId && convIds.has(card.convId)) || card.contactId === id)) continue
          const st = stages.find(s => s.id === card.stageId) || null
          deals.push({
            cardId: card.id, pipelineId: p.id, pipelineName: p.name,
            stageId: card.stageId || null, stageName: st?.name || '', stageColor: st?.color || '',
            title: card.title || '', value: card.value || '',
            convId: card.convId || null, agentId: card.agentId || null,
            createdAt: card.createdAt || null,
          })
        }
      }
      deals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    } catch { deals = [] }
    // El "valor" es texto libre en la tarjeta ("2 millones", "$1.500"), así que solo suma lo
    // que sea claramente numérico; si no, el total engañaría más que ayudar.
    const dealsValue = deals.reduce((s, d) => {
      const n = Number(String(d.value).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'))
      return s + (Number.isFinite(n) ? n : 0)
    }, 0)

    let orders = []
    try { [orders] = await pool.query("SELECT id, code, status, total, currency, type, payment_status, created_at FROM orders WHERE account_id=? AND contact_id=? AND status<>'draft' ORDER BY created_at DESC LIMIT 100", [accId, id]) } catch {}

    let bookings = []
    try { [bookings] = await pool.query('SELECT id, status, created_at FROM calendar_bookings WHERE account_id=? AND (customer_id=? OR (phone IS NOT NULL AND phone<>"" AND phone=?)) ORDER BY created_at DESC LIMIT 50', [accId, id, phone]) } catch {}

    const [notes] = await pool.query('SELECT id, content, author_name, ts FROM crm_notes WHERE account_id=? AND target_type="contact" AND target_id=? ORDER BY ts DESC LIMIT 100', [accId, id])
    const [tasks] = await pool.query('SELECT id, title, status, due_at, assignee_name, created_at, completed_at FROM crm_tasks WHERE account_id=? AND target_type="contact" AND target_id=? ORDER BY created_at DESC LIMIT 100', [accId, id])

    const notCanceled = orders.filter(o => o.status !== 'canceled')
    const revenue = notCanceled.reduce((s, o) => s + (Number(o.total) || 0), 0)
    const tsAll = [c.created_at, ...convos.map(x => x.created_at), ...orders.map(x => x.created_at), ...bookings.map(x => x.created_at)].filter(Boolean)
    const tsLast = [c.created_at, ...convos.map(x => x.updated_at || x.created_at), ...orders.map(x => x.created_at), ...bookings.map(x => x.created_at)].filter(Boolean)
    const currency = orders.find(o => o.currency)?.currency || 'COP'
    const metrics = {
      conversations: convos.length,
      orders: notCanceled.length,
      revenue: Math.round(revenue),
      avgTicket: notCanceled.length ? Math.round(revenue / notCanceled.length) : 0,
      bookings: bookings.length,
      openTasks: tasks.filter(t => t.status === 'open').length,
      deals: deals.length,
      dealsValue: Math.round(dealsValue),
      currency,
      firstInteraction: tsAll.length ? Math.min(...tsAll) : c.created_at,
      lastInteraction: tsLast.length ? Math.max(...tsLast) : c.created_at,
      aiHandled: convos.filter(x => x.ai_enabled).length,
    }

    const timeline = []
    for (const cv of convos) timeline.push({ type: 'conversation', ts: cv.created_at, agentId: cv.agent_id, channel: cv.channel_type, detail: cv.preview || '', convId: cv.id, topic: cv.topic || null, sentiment: cv.sentiment || null })
    for (const o of orders) timeline.push({ type: 'order', ts: o.created_at, code: o.code, status: o.status, amount: Number(o.total) || 0, currency: o.currency, paymentStatus: o.payment_status })
    for (const b of bookings) timeline.push({ type: 'booking', ts: b.created_at, status: b.status || '' })
    for (const n of notes) timeline.push({ type: 'note', ts: n.ts, author: n.author_name || '', detail: n.content || '' })
    for (const t of tasks) timeline.push({ type: 'task', ts: t.created_at, title: t.title, status: t.status, assignee: t.assignee_name || '', dueAt: t.due_at })
    for (const d of deals) if (d.createdAt) timeline.push({ type: 'deal', ts: d.createdAt, title: d.title, pipelineName: d.pipelineName, stageName: d.stageName, value: d.value, cardId: d.cardId, pipelineId: d.pipelineId })
    timeline.sort((a, b) => (b.ts || 0) - (a.ts || 0))

    res.json({ contact, metrics, deals, timeline: timeline.slice(0, 150) })
  } catch (err) { console.error('[CONTACT 360]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Exportar a CSV ──────────────────────────────────────────────────────────────
const exportCsv = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM contacts WHERE account_id=? ORDER BY created_at DESC', [accId])
    const contacts = rows.map(mapContact)
    const base = ['name', 'email', 'phone']
    const extraKeys = []
    for (const c of contacts) for (const k of Object.keys(c)) {
      if (k !== 'id' && k !== 'createdAt' && !base.includes(k) && !extraKeys.includes(k)) extraKeys.push(k)
    }
    const cols = [...base, ...extraKeys]
    const esc = v => { const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = [cols.join(',')]
    for (const c of contacts) lines.push(cols.map(k => esc(c[k])).join(','))
    const csv = '﻿' + lines.join('\r\n') // BOM para que Excel respete UTF-8
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="contactos.csv"')
    res.send(csv)
  } catch (err) { console.error('[EXPORT CONTACTS]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Importar en bloque ──────────────────────────────────────────────────────────
// body: { contacts: [{ name, email, phone, ...extra }], dedupeByPhone }
const importContacts = async (req, res) => {
  const { accId } = req.params
  const { contacts = [], dedupeByPhone = true } = req.body || {}
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'No hay contactos para importar' })
  try {
    let existingPhones = new Set()
    if (dedupeByPhone) {
      const [rows] = await pool.query('SELECT phone FROM contacts WHERE account_id=?', [accId])
      existingPhones = new Set(rows.map(r => String(r.phone || '').trim()).filter(Boolean))
    }
    let imported = 0, skipped = 0
    const values = []
    for (const raw of contacts) {
      const { name = '', email = '', phone = '', ...extra } = raw || {}
      const ph = String(phone || '').trim()
      if (!String(name).trim() && !ph && !String(email).trim()) { skipped++; continue }
      if (dedupeByPhone && ph && existingPhones.has(ph)) { skipped++; continue }
      if (ph) existingPhones.add(ph)
      values.push(['contact_' + uid(), accId, String(name || ''), String(email || ''), ph, JSON.stringify(extra || {}), Date.now()])
      imported++
    }
    for (let i = 0; i < values.length; i += 500) {
      const batch = values.slice(i, i + 500)
      if (batch.length) await pool.query('INSERT INTO contacts (id,account_id,name,email,phone,extra,created_at) VALUES ?', [batch])
    }
    res.json({ ok: true, imported, skipped })
  } catch (err) { console.error('[IMPORT CONTACTS]', err); res.status(500).json({ error: err.message || 'Error interno' }) }
}

module.exports = { list, getOne, create, update, remove, listConversations, profile360, exportCsv, importContacts }
