'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// ── Variables ─────────────────────────────────────────────────────────────────

const createVariable = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, type = 'local', defaultValue = '', description = '', isSystem = false } = req.body
  const id = gId || ('var_' + uid())
  try {
    await pool.query('INSERT INTO variables (id,account_id,name,type,default_value,description,is_system) VALUES (?,?,?,?,?,?,?)', [id, accId, name, type, defaultValue, description, isSystem ? 1 : 0])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateVariable = async (req, res) => {
  const { accId, varId } = req.params
  const { name, type, defaultValue, description } = req.body
  try {
    const sets = []; const vals = []
    if (name         !== undefined) { sets.push('name=?');          vals.push(name) }
    if (type         !== undefined) { sets.push('type=?');          vals.push(type) }
    if (defaultValue !== undefined) { sets.push('default_value=?'); vals.push(defaultValue) }
    if (description  !== undefined) { sets.push('description=?');   vals.push(description) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(varId, accId)
    await pool.query(`UPDATE variables SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteVariable = async (req, res) => {
  const { accId, varId } = req.params
  try {
    await pool.query('DELETE FROM variables WHERE id=? AND account_id=?', [varId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── AI Tools ──────────────────────────────────────────────────────────────────

const createAITool = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, description, collectFields = [], flowId = null, actionType = 'variable', n8nIntegrationId = null } = req.body
  const id = gId || ('tool_' + uid())
  try {
    await pool.query(
      'INSERT INTO ai_tools (id,account_id,name,description,collect_fields,flow_id,action_type,n8n_integration_id) VALUES (?,?,?,?,?,?,?,?)',
      [id, accId, name, description, JSON.stringify(collectFields), flowId, actionType, n8nIntegrationId]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { console.error('[createAITool]', err); res.status(500).json({ error: 'Error interno' }) }
}

const updateAITool = async (req, res) => {
  const { accId, toolId } = req.params
  const { name, description, collectFields, flowId, actionType, n8nIntegrationId } = req.body
  try {
    const sets = []; const vals = []
    if (name             !== undefined) { sets.push('name=?');               vals.push(name) }
    if (description      !== undefined) { sets.push('description=?');        vals.push(description) }
    if (collectFields    !== undefined) { sets.push('collect_fields=?');     vals.push(JSON.stringify(collectFields)) }
    if (flowId           !== undefined) { sets.push('flow_id=?');            vals.push(flowId) }
    if (actionType       !== undefined) { sets.push('action_type=?');        vals.push(actionType) }
    if (n8nIntegrationId !== undefined) { sets.push('n8n_integration_id=?'); vals.push(n8nIntegrationId) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(toolId, accId)
    await pool.query(`UPDATE ai_tools SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteAITool = async (req, res) => {
  const { accId, toolId } = req.params
  try {
    await pool.query('DELETE FROM ai_tools WHERE id=? AND account_id=?', [toolId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── CMS Assets (biblioteca de recursos del asistente) ───────────────────────────
// El binario ya se subió vía POST /api/media/:accId/upload (devuelve mediaId);
// aquí sólo se registra la ficha del recurso (nombre, descripción, etiquetas).

const createCmsAsset = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, description = '', tags = [], kind = 'file', mediaId = null,
          filename = '', mime = '', sizeBytes = 0, folderId = null, category = '',
          ragFileId = null, ragAgentId = null } = req.body
  if (!name || !mediaId) return res.status(400).json({ error: 'Nombre y archivo son obligatorios' })
  const id = gId || ('cms_' + uid())
  try {
    await pool.query(
      'INSERT INTO cms_assets (id,account_id,name,description,tags,kind,media_id,filename,mime,size_bytes,folder_id,category,rag_file_id,rag_agent_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, accId, name, description, JSON.stringify(tags || []), kind, mediaId, filename, mime, sizeBytes, folderId || null, category || '', ragFileId, ragAgentId, Date.now()]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { console.error('[createCmsAsset]', err); res.status(500).json({ error: 'Error interno' }) }
}

const updateCmsAsset = async (req, res) => {
  const { accId, assetId } = req.params
  const { name, description, tags, folderId, category, ragFileId, ragAgentId } = req.body
  try {
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');         vals.push(name) }
    if (description !== undefined) { sets.push('description=?');  vals.push(description) }
    if (tags        !== undefined) { sets.push('tags=?');         vals.push(JSON.stringify(tags || [])) }
    if (folderId    !== undefined) { sets.push('folder_id=?');    vals.push(folderId || null) }
    if (category    !== undefined) { sets.push('category=?');     vals.push(category || '') }
    if (ragFileId   !== undefined) { sets.push('rag_file_id=?');  vals.push(ragFileId) }
    if (ragAgentId  !== undefined) { sets.push('rag_agent_id=?'); vals.push(ragAgentId) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(assetId, accId)
    await pool.query(`UPDATE cms_assets SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── CMS: carpetas (simple | unit), etiquetas y categorías globales ──────────────
const createCmsFolder = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, type = 'simple', description = '' } = req.body
  if (!name) return res.status(400).json({ error: 'Nombre requerido' })
  const id = gId || ('fld_' + uid())
  try {
    await pool.query('INSERT INTO cms_folders (id,account_id,name,type,description,created_at) VALUES (?,?,?,?,?,?)',
      [id, accId, name, type === 'unit' ? 'unit' : 'simple', description, Date.now()])
    socket.emit(accId, 'account:updated', { accId }); res.json({ id })
  } catch (err) { console.error('[createCmsFolder]', err); res.status(500).json({ error: 'Error interno' }) }
}
const updateCmsFolder = async (req, res) => {
  const { accId, folderId } = req.params
  const { name, type, description } = req.body
  try {
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');        vals.push(name) }
    if (type        !== undefined) { sets.push('type=?');        vals.push(type === 'unit' ? 'unit' : 'simple') }
    if (description !== undefined) { sets.push('description=?'); vals.push(description) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(folderId, accId)
    await pool.query(`UPDATE cms_folders SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId }); res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}
const deleteCmsFolder = async (req, res) => {
  const { accId, folderId } = req.params
  try {
    await pool.query('DELETE FROM cms_folders WHERE id=? AND account_id=?', [folderId, accId])
    // Desvincula (no borra) los recursos que estaban dentro.
    await pool.query('UPDATE cms_assets SET folder_id=NULL WHERE folder_id=? AND account_id=?', [folderId, accId])
    socket.emit(accId, 'account:updated', { accId }); res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createCmsTag = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name } = req.body
  if (!name) return res.status(400).json({ error: 'Nombre requerido' })
  const id = gId || ('tag_' + uid())
  try {
    await pool.query('INSERT INTO cms_tags (id,account_id,name,created_at) VALUES (?,?,?,?)', [id, accId, name, Date.now()])
    socket.emit(accId, 'account:updated', { accId }); res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}
const deleteCmsTag = async (req, res) => {
  const { accId, tagId } = req.params
  try {
    await pool.query('DELETE FROM cms_tags WHERE id=? AND account_id=?', [tagId, accId])
    socket.emit(accId, 'account:updated', { accId }); res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createCmsCategory = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name } = req.body
  if (!name) return res.status(400).json({ error: 'Nombre requerido' })
  const id = gId || ('cat_' + uid())
  try {
    await pool.query('INSERT INTO cms_categories (id,account_id,name,created_at) VALUES (?,?,?,?)', [id, accId, name, Date.now()])
    socket.emit(accId, 'account:updated', { accId }); res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}
const deleteCmsCategory = async (req, res) => {
  const { accId, catId } = req.params
  try {
    await pool.query('DELETE FROM cms_categories WHERE id=? AND account_id=?', [catId, accId])
    socket.emit(accId, 'account:updated', { accId }); res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Stickers (biblioteca para enviar en los chats) ──────────────────────────────
// El binario se sube vía /api/media/:accId/upload; aquí se registra la referencia.
const createSticker = async (req, res) => {
  const { accId } = req.params
  const { id: gId, mediaId, mime = 'image/webp', name = '' } = req.body
  if (!mediaId) return res.status(400).json({ error: 'mediaId requerido' })
  const id = gId || ('stk_' + uid())
  try {
    await pool.query('INSERT INTO stickers (id,account_id,media_id,mime,name,created_at) VALUES (?,?,?,?,?,?)', [id, accId, mediaId, mime, name, Date.now()])
    socket.emit(accId, 'account:updated', { accId }); res.json({ id })
  } catch (err) { console.error('[createSticker]', err); res.status(500).json({ error: 'Error interno' }) }
}
const deleteSticker = async (req, res) => {
  const { accId, stickerId } = req.params
  try {
    const [[s]] = await pool.query('SELECT media_id FROM stickers WHERE id=? AND account_id=?', [stickerId, accId])
    await pool.query('DELETE FROM stickers WHERE id=? AND account_id=?', [stickerId, accId])
    if (s?.media_id) { try { await pool.query('DELETE FROM media WHERE id=? AND account_id=?', [s.media_id, accId]) } catch {} }
    socket.emit(accId, 'account:updated', { accId }); res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteCmsAsset = async (req, res) => {
  const { accId, assetId } = req.params
  try {
    const [[a]] = await pool.query('SELECT media_id FROM cms_assets WHERE id=? AND account_id=?', [assetId, accId])
    await pool.query('DELETE FROM cms_assets WHERE id=? AND account_id=?', [assetId, accId])
    // Limpia el binario asociado para no dejar huérfanos en la tabla media.
    if (a?.media_id) { try { await pool.query('DELETE FROM media WHERE id=? AND account_id=?', [a.media_id, accId]) } catch {} }
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Flows ─────────────────────────────────────────────────────────────────────

const createFlow = async (req, res) => {
  const { accId } = req.params
  const { id: gId, name, trigger, startNodeId = null, nodes = [] } = req.body
  const id = gId || ('flow_' + uid())
  // Guard: a non-super-admin may only create/copy flows into accounts they belong to.
  // This protects the "copiar a otra cuenta" path from targeting arbitrary accounts.
  const allowed = req.user?.allAccountIds || []
  if (req.user?.type !== 'superadmin' && allowed.length && !allowed.includes(accId)) {
    return res.status(403).json({ error: 'Sin acceso a esa cuenta' })
  }
  try {
    await pool.query('INSERT INTO flows (id,account_id,name,`trigger`,start_node_id,nodes) VALUES (?,?,?,?,?,?)', [id, accId, name, trigger, startNodeId, JSON.stringify(nodes)])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateFlow = async (req, res) => {
  const { accId, flowId } = req.params
  const { name, trigger, startNodeId, nodes } = req.body
  try {
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');          vals.push(name) }
    if (trigger     !== undefined) { sets.push('`trigger`=?');     vals.push(trigger) }
    if (startNodeId !== undefined) { sets.push('start_node_id=?'); vals.push(startNodeId) }
    if (nodes       !== undefined) { sets.push('nodes=?');         vals.push(JSON.stringify(nodes)) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(flowId, accId)
    await pool.query(`UPDATE flows SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteFlow = async (req, res) => {
  const { accId, flowId } = req.params
  try {
    await pool.query('DELETE FROM flows WHERE id=? AND account_id=?', [flowId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = {
  createVariable, updateVariable, deleteVariable,
  createAITool, updateAITool, deleteAITool,
  createCmsAsset, updateCmsAsset, deleteCmsAsset,
  createCmsFolder, updateCmsFolder, deleteCmsFolder,
  createCmsTag, deleteCmsTag,
  createCmsCategory, deleteCmsCategory,
  createSticker, deleteSticker,
  createFlow, updateFlow, deleteFlow,
}
