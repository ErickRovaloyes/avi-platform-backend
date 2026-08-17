'use strict'
/**
 * Catálogo de herramientas IA.
 *
 * La plataforma publica herramientas —implementaciones hechas para un cliente concreto que
 * resultan útiles para más— y cada cuenta instala las que quiera. Al instalar se COPIA a las
 * herramientas de la cuenta (`ai_tools`), no se enlaza: así el cliente puede ajustarla a su
 * negocio, y una actualización nuestra no le cambia el comportamiento sin avisar. La ficha
 * guarda de dónde vino y con qué versión, para poder ofrecerle la actualización cuando la haya.
 *
 * Para el resto de la plataforma, una herramienta instalada es una herramienta normal: el motor
 * de flujos no distingue, y por eso no hubo que tocarlo.
 */
const pool = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

const esSuperadmin = u => u?.type === 'superadmin'

const mapTool = r => ({
  id: r.id,
  name: r.name,
  summary: r.summary || '',
  description: r.description || '',
  icon: r.icon || 'enchufe',
  category: r.category || 'General',
  collectFields: parseJ(r.collect_fields, []),
  actionType: r.action_type || 'variable',
  flowTemplate: parseJ(r.flow_template, null),
  version: Number(r.version) || 1,
  published: !!r.published,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

// ── Lectura ───────────────────────────────────────────────────────────────────

/**
 * El catálogo que ve una cuenta: solo lo publicado, y marcando lo que ya tiene instalado.
 * El super admin ve además los borradores, que es lo que le permite preparar una herramienta
 * antes de enseñarla.
 */
const listCatalog = async (req, res) => {
  const { accId } = req.params
  try {
    const soloPublicadas = !esSuperadmin(req.user)
    const [rows] = await pool.query(
      `SELECT * FROM tool_catalog ${soloPublicadas ? 'WHERE published=1' : ''} ORDER BY category, name`
    )
    let instaladas = []
    if (accId) {
      const [ins] = await pool.query(
        'SELECT catalog_id, catalog_version FROM ai_tools WHERE account_id=? AND catalog_id IS NOT NULL', [accId]
      )
      instaladas = ins
    }
    const porId = Object.fromEntries(instaladas.map(i => [i.catalog_id, Number(i.catalog_version) || 0]))
    res.json(rows.map(r => {
      const t = mapTool(r)
      const vInstalada = porId[t.id]
      return {
        ...t,
        installed: vInstalada !== undefined,
        // Solo se ofrece actualizar si la del catálogo es MÁS NUEVA que la instalada.
        updateAvailable: vInstalada !== undefined && t.version > vInstalada,
        installedVersion: vInstalada,
      }
    }))
  } catch (err) { console.error('[listCatalog]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Publicación (super admin) ─────────────────────────────────────────────────

const upsertCatalogTool = async (req, res) => {
  if (!esSuperadmin(req.user)) return res.status(403).json({ error: 'Solo el super admin gestiona el catálogo.' })
  const { toolId } = req.params
  const b = req.body || {}
  const ahora = Date.now()
  try {
    if (toolId) {
      const [[actual]] = await pool.query('SELECT version FROM tool_catalog WHERE id=?', [toolId])
      if (!actual) return res.status(404).json({ error: 'Esa herramienta no está en el catálogo.' })
      // La versión sube SOLO si se pide. Corregir una errata no debería avisar de actualización
      // a todos los que ya la tienen instalada.
      const version = b.bumpVersion ? Number(actual.version) + 1 : Number(actual.version)
      await pool.query(
        `UPDATE tool_catalog SET name=?, summary=?, description=?, icon=?, category=?,
                collect_fields=?, action_type=?, flow_template=?, version=?, published=?, updated_at=?
           WHERE id=?`,
        [b.name, b.summary || '', b.description || '', b.icon || 'enchufe', b.category || 'General',
         JSON.stringify(b.collectFields || []), b.actionType || 'variable',
         b.flowTemplate ? JSON.stringify(b.flowTemplate) : null,
         version, b.published ? 1 : 0, ahora, toolId]
      )
      return res.json({ id: toolId, version })
    }
    const id = 'cat_' + uid()
    await pool.query(
      `INSERT INTO tool_catalog (id,name,summary,description,icon,category,collect_fields,action_type,flow_template,version,published,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name, b.summary || '', b.description || '', b.icon || 'enchufe', b.category || 'General',
       JSON.stringify(b.collectFields || []), b.actionType || 'variable',
       b.flowTemplate ? JSON.stringify(b.flowTemplate) : null,
       1, b.published ? 1 : 0, ahora, ahora]
    )
    res.json({ id, version: 1 })
  } catch (err) { console.error('[upsertCatalogTool]', err); res.status(500).json({ error: 'Error interno' }) }
}

const deleteCatalogTool = async (req, res) => {
  if (!esSuperadmin(req.user)) return res.status(403).json({ error: 'Solo el super admin gestiona el catálogo.' })
  try {
    // Las copias ya instaladas NO se tocan: son del cliente y siguen funcionando. Solo se
    // quedan sin origen, y por eso `catalog_id` puede apuntar a algo que ya no existe.
    await pool.query('DELETE FROM tool_catalog WHERE id=?', [req.params.toolId])
    res.json({ ok: true })
  } catch (err) { console.error('[deleteCatalogTool]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Instalación (la cuenta) ───────────────────────────────────────────────────

function puedeInstalar(user, accId) {
  if (!user) return 'No hay sesión.'
  if (esSuperadmin(user) || user.isImpersonating) return null
  if (user.type !== 'member') return 'No tienes acceso a esta cuenta.'
  if (String(user.accountId) !== String(accId)) return 'Esta cuenta no es la tuya.'
  const esDueno = String(user.roleId || '').startsWith('role_owner')
  if (!esDueno && !user.permissions?.admins) return 'No tienes permiso para instalar herramientas.'
  return null
}

/**
 * Instala (o actualiza) una herramienta del catálogo en una cuenta.
 *
 * Actualizar reescribe la copia con la versión nueva. Se avisa en la interfaz de que se pierden
 * los ajustes locales, porque es exactamente lo que pasa.
 */
const installTool = async (req, res) => {
  const { accId, toolId } = req.params
  const error = puedeInstalar(req.user, accId)
  if (error) return res.status(403).json({ error })
  try {
    const [[c]] = await pool.query('SELECT * FROM tool_catalog WHERE id=? AND published=1', [toolId])
    if (!c) return res.status(404).json({ error: 'Esa herramienta no está disponible en el catálogo.' })

    const [[ya]] = await pool.query('SELECT id FROM ai_tools WHERE account_id=? AND catalog_id=?', [accId, toolId])
    if (ya) {
      await pool.query(
        'UPDATE ai_tools SET name=?, description=?, collect_fields=?, action_type=?, catalog_version=? WHERE id=?',
        [c.name, c.description || '', c.collect_fields || '[]', c.action_type || 'variable', c.version, ya.id]
      )
      socket.emit(accId, 'account:updated', { accId })
      return res.json({ id: ya.id, updated: true, version: Number(c.version) })
    }

    const id = 'tool_' + uid()
    await pool.query(
      'INSERT INTO ai_tools (id,account_id,name,description,collect_fields,flow_id,action_type,catalog_id,catalog_version) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, accId, c.name, c.description || '', c.collect_fields || '[]', null, c.action_type || 'variable', c.id, c.version]
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id, installed: true, version: Number(c.version) })
  } catch (err) { console.error('[installTool]', err); res.status(500).json({ error: 'Error interno' }) }
}

const uninstallTool = async (req, res) => {
  const { accId, toolId } = req.params
  const error = puedeInstalar(req.user, accId)
  if (error) return res.status(403).json({ error })
  try {
    await pool.query('DELETE FROM ai_tools WHERE account_id=? AND catalog_id=?', [accId, toolId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { console.error('[uninstallTool]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { listCatalog, upsertCatalogTool, deleteCatalogTool, installTool, uninstallTool }
