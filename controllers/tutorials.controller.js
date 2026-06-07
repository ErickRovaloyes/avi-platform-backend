'use strict'
const pool = require('../db')
const { uid } = require('../utils')

const list = async (req, res) => {
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo superadmin' })
  try {
    const [rows] = await pool.query('SELECT * FROM tutorials ORDER BY sort_order ASC, created_at DESC')
    res.json(rows)
  } catch (err) { console.error('[TUTORIALS list]', err); res.status(500).json({ error: 'Error interno' }) }
}

const listPublic = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tutorials WHERE published=1 ORDER BY sort_order ASC, created_at DESC')
    res.json(rows)
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo superadmin' })
  const { title, category = 'general', excerpt = '', content = '', thumbnail = '', published = 1, sort_order = 0 } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Titulo requerido' })
  try {
    const id = uid()
    const now = Date.now()
    await pool.query(
      'INSERT INTO tutorials (id,title,category,excerpt,content,thumbnail,published,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, title.trim(), category, excerpt, content, thumbnail, published ? 1 : 0, sort_order, now, now]
    )
    const [[row]] = await pool.query('SELECT * FROM tutorials WHERE id=?', [id])
    res.status(201).json(row)
  } catch (err) { console.error('[TUTORIALS create]', err); res.status(500).json({ error: 'Error interno' }) }
}

const update = async (req, res) => {
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo superadmin' })
  const { id } = req.params
  const { title, category, excerpt, content, thumbnail, published, sort_order } = req.body
  try {
    const sets = []; const vals = []
    if (title      !== undefined) { sets.push('title=?');      vals.push(title.trim()) }
    if (category   !== undefined) { sets.push('category=?');   vals.push(category) }
    if (excerpt    !== undefined) { sets.push('excerpt=?');     vals.push(excerpt) }
    if (content    !== undefined) { sets.push('content=?');    vals.push(content) }
    if (thumbnail  !== undefined) { sets.push('thumbnail=?');  vals.push(thumbnail) }
    if (published  !== undefined) { sets.push('published=?');  vals.push(published ? 1 : 0) }
    if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order) }
    sets.push('updated_at=?'); vals.push(Date.now())
    vals.push(id)
    await pool.query(`UPDATE tutorials SET ${sets.join(',')} WHERE id=?`, vals)
    const [[row]] = await pool.query('SELECT * FROM tutorials WHERE id=?', [id])
    res.json(row || { ok: true })
  } catch (err) { console.error('[TUTORIALS update]', err); res.status(500).json({ error: 'Error interno' }) }
}

const destroy = async (req, res) => {
  if (req.user?.type !== 'superadmin') return res.status(403).json({ error: 'Solo superadmin' })
  try {
    await pool.query('DELETE FROM tutorials WHERE id=?', [req.params.id])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, listPublic, create, update, destroy }
