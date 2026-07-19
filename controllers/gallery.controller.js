'use strict'
/**
 * Galería de medios: archivos PERSONALES (del miembro) y de EQUIPO (compartidos por la
 * cuenta). El medio real vive en el store de media (media_id); aquí solo se guarda la
 * referencia. La división "CMS" NO vive aquí: el frontend la lee de account.cmsAssets
 * (unidireccional: lo del CMS aparece en la galería, pero no al revés).
 */
const pool = require('../db')
const { uid } = require('../utils')

const map = r => ({
  id: r.id, scope: r.scope, ownerId: r.owner_id || null, name: r.name || '',
  kind: r.kind || 'file', mediaId: r.media_id, mime: r.mime || '', sizeBytes: Number(r.size_bytes) || 0,
  filename: r.filename || '', createdBy: r.created_by || '', createdAt: r.created_at,
})

// Devuelve { personal: [...], team: [...] } — personal = del usuario actual.
const list = async (req, res) => {
  const { accId } = req.params
  const uidCur = req.user?.id || null
  try {
    const [rows] = await pool.query(
      "SELECT * FROM gallery_items WHERE account_id=? AND (scope='team' OR (scope='personal' AND owner_id=?)) ORDER BY created_at DESC",
      [accId, uidCur]
    )
    const personal = [], team = []
    for (const r of rows) (r.scope === 'team' ? team : personal).push(map(r))
    res.json({ personal, team })
  } catch (err) { console.error('[gallery list]', err); res.status(500).json({ error: 'Error interno' }) }
}

const create = async (req, res) => {
  const { accId } = req.params
  const { scope = 'personal', name = '', kind = 'file', mediaId, mime = '', sizeBytes = 0, filename = '' } = req.body || {}
  if (!mediaId) return res.status(400).json({ error: 'mediaId requerido' })
  const sc = scope === 'team' ? 'team' : 'personal'
  const id = 'gal_' + uid()
  try {
    await pool.query(
      'INSERT INTO gallery_items (id, account_id, scope, owner_id, name, kind, media_id, mime, size_bytes, filename, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, accId, sc, req.user?.id || null, String(name || filename || 'archivo').slice(0, 255), kind, mediaId, mime, Number(sizeBytes) || 0, filename, req.user?.name || '', Date.now()]
    )
    res.json({ id })
  } catch (err) { console.error('[gallery create]', err); res.status(500).json({ error: 'Error interno' }) }
}

const remove = async (req, res) => {
  const { accId, id } = req.params
  try {
    const [[it]] = await pool.query('SELECT scope, owner_id FROM gallery_items WHERE id=? AND account_id=?', [id, accId])
    if (!it) return res.json({ ok: true })
    // Los personales solo los borra su dueño; los de equipo, cualquier miembro de la cuenta.
    if (it.scope === 'personal' && it.owner_id && req.user?.id && it.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Solo el dueño puede eliminar este archivo personal' })
    }
    await pool.query('DELETE FROM gallery_items WHERE id=? AND account_id=?', [id, accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list, create, remove }
