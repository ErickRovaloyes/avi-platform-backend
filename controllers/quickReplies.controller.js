'use strict'
const pool = require('../db')
const { uid } = require('../utils')

const list = async (req, res) => {
  const { accId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM quick_replies WHERE account_id=? ORDER BY title ASC', [accId])
    res.json(rows.map(r => ({
      id: r.id, shortcut: r.shortcut, title: r.title, content: r.content,
      mediaData: r.media_data || '', mediaKind: r.media_kind || '',
      createdBy: r.created_by, createdAt: r.created_at,
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const { shortcut = '', title = '', content = '', mediaData = '', mediaKind = '' } = req.body || {}
  // Se permite una respuesta rápida SOLO de audio/medio (sin texto) o de solo texto.
  if (!title.trim() || (!content.trim() && !mediaData)) return res.status(400).json({ error: 'title y (content o audio) son requeridos' })
  const id = 'qr_' + uid()
  try {
    await pool.query(
      'INSERT INTO quick_replies (id, account_id, shortcut, title, content, media_data, media_kind, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, accId, shortcut.trim(), title.trim(), content, mediaData || null, mediaKind || null, req.user?.name || '', Date.now()]
    )
    res.json({ id })
  } catch (err) { console.error('[CREATE QR]', err); res.status(500).json({ error: 'Error interno' }) }
}

const update = async (req, res) => {
  const { accId, id } = req.params
  const { shortcut, title, content, mediaData, mediaKind } = req.body || {}
  try {
    const sets = []; const vals = []
    if (shortcut !== undefined) { sets.push('shortcut=?'); vals.push((shortcut || '').trim()) }
    if (title    !== undefined) { sets.push('title=?');    vals.push((title || '').trim()) }
    if (content  !== undefined) { sets.push('content=?');  vals.push(content) }
    if (mediaData !== undefined) { sets.push('media_data=?'); vals.push(mediaData || null) }
    if (mediaKind !== undefined) { sets.push('media_kind=?'); vals.push(mediaKind || null) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(id, accId)
    await pool.query(`UPDATE quick_replies SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  try {
    await pool.query('DELETE FROM quick_replies WHERE id=? AND account_id=?', [id, accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, update, remove }
