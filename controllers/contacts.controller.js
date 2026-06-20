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
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  try {
    // Borrar también los chats vinculados a este contacto (y sus mensajes/media).
    const [convos] = await pool.query(
      `SELECT id, agent_id FROM conversations
       WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars,'$.contact_id'))=?`,
      [accId, id]
    )
    const convIds = convos.map(c => c.id)
    if (convIds.length) {
      await pool.query('DELETE FROM messages WHERE conversation_id IN (?)', [convIds])
      try { await pool.query('DELETE FROM media WHERE conversation_id IN (?)', [convIds]) } catch {}
      await pool.query('DELETE FROM conversations WHERE id IN (?) AND account_id=?', [convIds, accId])
    }
    await pool.query('DELETE FROM contacts WHERE id=? AND account_id=?', [id, accId])

    // Refrescar el inbox de cada agente afectado
    const agentIds = [...new Set(convos.map(c => c.agent_id))]
    agentIds.forEach(agId => socket.emit(accId, 'convos:updated', { accId, agId }))
    res.json({ ok: true, deletedConversations: convIds.length })
  } catch (err) { console.error('[DELETE CONTACT]', err); res.status(500).json({ error: 'Error interno' }) }
}

const listConversations = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [rows] = await pool.query(
      `SELECT id, agent_id, channel_type, guest_name, preview, created_at, updated_at
       FROM conversations
       WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars, '$.contact_id'))=?
       ORDER BY updated_at DESC
       LIMIT 50`,
      [accId, id]
    )
    res.json(rows.map(c => ({
      id: c.id, agentId: c.agent_id, channel: c.channel_type,
      guestName: c.guest_name, preview: c.preview,
      createdAt: c.created_at, updatedAt: c.updated_at,
    })))
  } catch (err) {
    console.error('[CONTACT CONVOS]', err)
    res.status(500).json({ error: 'Error interno' })
  }
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

module.exports = { list, getOne, create, update, remove, listConversations, exportCsv, importContacts }
