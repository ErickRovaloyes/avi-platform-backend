'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// Deterministic DM channel id from two member ids (order-independent)
const dmId = (a, b) => 'dm_' + [a, b].sort().join('__')
const dmParts = (chId) => chId.slice(3).split('__')

// ── Messages ────────────────────────────────────────────────────────────────
const getMessages = async (req, res) => {
  const { accId } = req.params
  const { channel } = req.query
  try {
    // DM access control: only participants (or super admin) can read
    if (channel && channel.startsWith('dm_')) {
      const parts = dmParts(channel)
      if (req.user.type !== 'superadmin' && req.user.id && !parts.includes(req.user.id)) {
        return res.status(403).json({ error: 'Sin acceso a este chat' })
      }
    }
    let q = 'SELECT * FROM team_chat WHERE account_id=?'
    const p = [accId]
    if (channel) { q += ' AND channel=?'; p.push(channel) }
    q += ' ORDER BY ts ASC LIMIT 500'
    const [rows] = await pool.query(q, p)
    res.json(rows.map(r => ({
      id: r.id, authorId: r.author_id, authorName: r.author_name,
      authorAvatar: r.author_avatar, channel: r.channel, content: r.content, ts: r.ts,
      media: parseJ(r.media, null),
    })))
  } catch (err) { console.error('[TC GET]', err); res.status(500).json({ error: 'Error interno' }) }
}

const postMessage = async (req, res) => {
  const { accId } = req.params
  const { authorId, authorName, authorAvatar, channel = 'general', content, media = null } = req.body
  const id = 'tcm_' + uid()
  const ts = Date.now()
  try {
    await pool.query(
      'INSERT INTO team_chat (id,account_id,author_id,author_name,author_avatar,channel,content,ts,media) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, accId, authorId, authorName, authorAvatar, channel, content, ts, media ? JSON.stringify(media) : null]
    )
    const msg = { id, authorId, authorName, authorAvatar, channel, content, ts, media }
    if (channel.startsWith('dm_')) {
      // Direct message: deliver only to the two participants' personal rooms
      const parts = dmParts(channel)
      parts.forEach(memId => socket.emitToMember(memId, 'teamchat:message', { accId, msg }))
      await pool.query('UPDATE team_channels SET updated_at=? WHERE id=?', [ts, channel]).catch(() => {})
    } else {
      // Channel message: deliver to everyone in the account
      socket.emit(accId, 'teamchat:message', { accId, msg })
    }
    res.json(msg)
  } catch (err) { console.error('[TC POST]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Channels & DMs ────────────────────────────────────────────────────────────
const listChannels = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM team_channels WHERE account_id=? ORDER BY created_at ASC', [accId])
    const myId = req.user.id
    const isSA = req.user.type === 'superadmin'
    const channels = []
    const dms = []
    for (const r of rows) {
      const members = parseJ(r.members, [])
      if (r.type === 'dm') {
        if (isSA || (myId && members.includes(myId))) {
          dms.push({ id: r.id, type: 'dm', members, updatedAt: r.updated_at || r.created_at })
        }
      } else {
        channels.push({ id: r.id, name: r.name, type: 'channel', createdBy: r.created_by, createdAt: r.created_at })
      }
    }
    res.json({ channels, dms })
  } catch (err) { console.error('[TC CHANS]', err); res.status(500).json({ error: 'Error interno' }) }
}

const createChannel = async (req, res) => {
  const { accId } = req.params
  const { name } = req.body
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' })
  const id = 'tch_' + uid()
  const ts = Date.now()
  try {
    await pool.query(
      'INSERT INTO team_channels (id,account_id,name,type,members,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, accId, name.trim(), 'channel', JSON.stringify([]), req.user.id || null, ts, ts]
    )
    socket.emit(accId, 'teamchat:channels', { accId })
    res.json({ id, name: name.trim(), type: 'channel', createdBy: req.user.id, createdAt: ts })
  } catch (err) { console.error('[TC CREATE CHAN]', err); res.status(500).json({ error: 'Error interno' }) }
}

const deleteChannel = async (req, res) => {
  const { accId, chId } = req.params
  try {
    await pool.query('DELETE FROM team_channels WHERE id=? AND account_id=? AND type="channel"', [chId, accId])
    await pool.query('DELETE FROM team_chat WHERE account_id=? AND channel=?', [accId, chId])
    socket.emit(accId, 'teamchat:channels', { accId })
    res.json({ ok: true })
  } catch (err) { console.error('[TC DEL CHAN]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Get-or-create a DM channel between the requester and another member
const openDM = async (req, res) => {
  const { accId } = req.params
  const { memberId } = req.body
  const me = req.user.id
  if (!me || !memberId) return res.status(400).json({ error: 'Falta el participante' })
  if (me === memberId) return res.status(400).json({ error: 'No puedes abrir un chat contigo mismo' })
  const id = dmId(me, memberId)
  const ts = Date.now()
  try {
    const [[existing]] = await pool.query('SELECT id FROM team_channels WHERE id=?', [id])
    if (!existing) {
      await pool.query(
        'INSERT INTO team_channels (id,account_id,name,type,members,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, accId, '', 'dm', JSON.stringify([me, memberId]), me, ts, ts]
      )
    }
    // Notify the other participant so the DM shows up in their list immediately
    socket.emitToMember(memberId, 'teamchat:channels', { accId })
    res.json({ id, type: 'dm', members: [me, memberId] })
  } catch (err) { console.error('[TC OPEN DM]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Supervisión (superadmin): resumen de los chats privados directos (DMs) ─────
// Devuelve los DMs de una cuenta con los nombres de los participantes, el último
// mensaje y el conteo, para que el superadmin pueda monitorearlos.
const dmsOverview = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo superadmin' })
  const { accId } = req.params
  try {
    const [chans] = await pool.query("SELECT * FROM team_channels WHERE account_id=? AND type='dm' ORDER BY updated_at DESC, created_at DESC", [accId])
    if (!chans.length) return res.json({ dms: [] })
    const [members] = await pool.query('SELECT id, name, email, avatar FROM members WHERE account_id=?', [accId])
    const memById = Object.fromEntries(members.map(m => [m.id, m]))
    const dms = []
    for (const c of chans) {
      const ids = parseJ(c.members, [])
      const [[last]] = await pool.query('SELECT author_name, content, ts FROM team_chat WHERE channel=? ORDER BY ts DESC LIMIT 1', [c.id])
      const [[cnt]]  = await pool.query('SELECT COUNT(*) AS n FROM team_chat WHERE channel=?', [c.id])
      dms.push({
        id: c.id,
        participants: ids.map(id => ({ id, name: memById[id]?.name || id, email: memById[id]?.email || '' })),
        lastMessage: last ? { authorName: last.author_name, content: last.content, ts: last.ts } : null,
        messageCount: cnt?.n || 0,
        updatedAt: c.updated_at || c.created_at,
      })
    }
    res.json({ dms })
  } catch (err) { console.error('[TC DMS OVERVIEW]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { getMessages, postMessage, listChannels, createChannel, deleteChannel, openDM, dmsOverview }
