'use strict'
/**
 * Tablas internas tipo Excel (bases de datos del cliente). El cliente las crea y
 * edita en el panel; el agente IA puede consultarlas y modificarlas (si ai_enabled)
 * vía toolCall(), con paridad al patrón de scheduling.toolCall.
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')

// ── Helpers ─────────────────────────────────────────────────────────────────
function norm(s) {
  return String(s ?? '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}
function slug(label) {
  return norm(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || ('col_' + uid().slice(0, 4))
}
// Normaliza el array de columnas: [{key,label,type}]. Genera key desde label si falta.
function normColumns(cols) {
  const out = [], seen = new Set()
  for (const c of (Array.isArray(cols) ? cols : [])) {
    const label = String(c?.label ?? c?.key ?? '').trim()
    if (!label) continue
    let key = c?.key ? slug(c.key) : slug(label)
    while (seen.has(key)) key += '_'
    seen.add(key)
    out.push({ key, label, type: c?.type === 'number' ? 'number' : 'text' })
  }
  return out.slice(0, 40)
}
function coerce(col, v) {
  if (v == null || v === '') return col.type === 'number' ? null : ''
  if (col.type === 'number') { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null }
  return String(v)
}
// Solo conserva las claves que son columnas de la tabla (coaccionadas por tipo).
function cleanValues(columns, values) {
  const out = {}
  const byKey = Object.fromEntries(columns.map(c => [c.key, c]))
  const byLabel = Object.fromEntries(columns.map(c => [norm(c.label), c]))
  for (const [k, v] of Object.entries(values || {})) {
    const col = byKey[k] || byKey[slug(k)] || byLabel[norm(k)]
    if (col) out[col.key] = coerce(col, v)
  }
  return out
}
const mapTable = t => ({ id: t.id, name: t.name, description: t.description || '', columns: parseJ(t.columns, []), aiEnabled: !!t.ai_enabled, createdAt: t.created_at, updatedAt: t.updated_at })
const mapRow = r => ({ id: r.id, tableId: r.table_id, values: parseJ(r.values_json, {}), createdAt: r.created_at, updatedAt: r.updated_at })

// ── CRUD tablas ─────────────────────────────────────────────────────────────
async function listTables(accId) {
  const [rows] = await pool.query('SELECT * FROM data_tables WHERE account_id=? ORDER BY created_at DESC', [accId])
  return rows.map(mapTable)
}
async function getTable(accId, id) {
  const [[t]] = await pool.query('SELECT * FROM data_tables WHERE id=? AND account_id=?', [id, accId])
  return t ? mapTable(t) : null
}
async function createTable(accId, { name, description, columns, aiEnabled } = {}) {
  const id = 'dt_' + uid(); const now = Date.now()
  await pool.query('INSERT INTO data_tables (id, account_id, name, description, columns, ai_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, accId, String(name || 'Tabla').slice(0, 160), description || '', JSON.stringify(normColumns(columns)), aiEnabled === false ? 0 : 1, now, now])
  return getTable(accId, id)
}
async function updateTable(accId, id, patch = {}) {
  const sets = [], vals = []
  if (patch.name !== undefined)        { sets.push('name=?');        vals.push(String(patch.name).slice(0, 160)) }
  if (patch.description !== undefined) { sets.push('description=?'); vals.push(patch.description || '') }
  if (patch.columns !== undefined)     { sets.push('columns=?');     vals.push(JSON.stringify(normColumns(patch.columns))) }
  if (patch.aiEnabled !== undefined)   { sets.push('ai_enabled=?');  vals.push(patch.aiEnabled ? 1 : 0) }
  if (!sets.length) return getTable(accId, id)
  sets.push('updated_at=?'); vals.push(Date.now()); vals.push(id, accId)
  await pool.query(`UPDATE data_tables SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
  return getTable(accId, id)
}
async function deleteTable(accId, id) {
  await pool.query('DELETE FROM data_table_rows WHERE table_id=? AND account_id=?', [id, accId]).catch(() => {})
  await pool.query('DELETE FROM data_tables WHERE id=? AND account_id=?', [id, accId])
  return { ok: true }
}

// ── CRUD filas ──────────────────────────────────────────────────────────────
async function listRows(accId, tableId, { q, limit = 500, offset = 0 } = {}) {
  const [rows] = await pool.query('SELECT * FROM data_table_rows WHERE table_id=? AND account_id=? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    [tableId, accId, Math.min(2000, Number(limit) || 500), Number(offset) || 0])
  let out = rows.map(mapRow)
  if (q && q.trim()) { const needle = norm(q); out = out.filter(r => Object.values(r.values).some(v => norm(v).includes(needle))) }
  return out
}
async function createRow(accId, tableId, values) {
  const t = await getTable(accId, tableId); if (!t) throw new Error('Tabla no encontrada')
  const id = 'row_' + uid(); const now = Date.now()
  await pool.query('INSERT INTO data_table_rows (id, table_id, account_id, values_json, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [id, tableId, accId, JSON.stringify(cleanValues(t.columns, values)), now, now])
  const [[r]] = await pool.query('SELECT * FROM data_table_rows WHERE id=?', [id])
  return mapRow(r)
}
async function updateRow(accId, tableId, rowId, values) {
  const t = await getTable(accId, tableId); if (!t) throw new Error('Tabla no encontrada')
  const [[cur]] = await pool.query('SELECT * FROM data_table_rows WHERE id=? AND table_id=? AND account_id=?', [rowId, tableId, accId])
  if (!cur) throw new Error('Fila no encontrada')
  const merged = { ...parseJ(cur.values_json, {}), ...cleanValues(t.columns, values) }
  await pool.query('UPDATE data_table_rows SET values_json=?, updated_at=? WHERE id=?', [JSON.stringify(merged), Date.now(), rowId])
  const [[r]] = await pool.query('SELECT * FROM data_table_rows WHERE id=?', [rowId])
  return mapRow(r)
}
async function deleteRow(accId, tableId, rowId) {
  await pool.query('DELETE FROM data_table_rows WHERE id=? AND table_id=? AND account_id=?', [rowId, tableId, accId])
  return { ok: true }
}

// ── Config pública (para la IA): solo tablas ai_enabled ─────────────────────
async function publicConfig(accId) {
  try {
    const [rows] = await pool.query('SELECT id, name, description, columns FROM data_tables WHERE account_id=? AND ai_enabled=1', [accId])
    const tables = rows.map(t => ({ id: t.id, name: t.name, description: t.description || '', columns: parseJ(t.columns, []) }))
    return { connected: tables.length > 0, tables }
  } catch { return { connected: false, tables: [] } }
}

// ── Dispatcher de la IA ──────────────────────────────────────────────────────
async function resolveTable(accId, tabla) {
  const [rows] = await pool.query('SELECT * FROM data_tables WHERE account_id=? AND ai_enabled=1', [accId])
  const list = rows.map(mapTable)
  const q = norm(tabla)
  return list.find(t => t.id === tabla) || list.find(t => norm(t.name) === q) || list.find(t => norm(t.name).includes(q)) || null
}
function rowMatches(values, filter, columns) {
  const byLabel = Object.fromEntries(columns.map(c => [norm(c.label), c]))
  const byKey = Object.fromEntries(columns.map(c => [c.key, c]))
  for (const [k, want] of Object.entries(filter || {})) {
    const col = byKey[k] || byKey[slug(k)] || byLabel[norm(k)]
    if (!col) continue
    const have = values[col.key]
    if (col.type === 'number') { if (Number(have) !== Number(want)) return false }
    else if (norm(have) !== norm(want)) return false
  }
  return true
}
function rowToText(values, columns) {
  return columns.map(c => `${c.label}: ${values[c.key] ?? ''}`).join(' · ')
}

async function toolCall(accId, fn, args = {}) {
  try {
    const tabla = args.tabla || args.table || args.nombre_tabla
    const t = await resolveTable(accId, tabla)
    if (!t) return { text: `No encontré la tabla "${tabla || ''}". Tablas disponibles: ${(await publicConfig(accId)).tables.map(x => x.name).join(', ') || 'ninguna'}.` }
    const columns = t.columns

    if (fn === 'consultar_tabla') {
      const [rows] = await pool.query('SELECT values_json FROM data_table_rows WHERE table_id=? AND account_id=? ORDER BY created_at ASC LIMIT 2000', [t.id, accId])
      let vals = rows.map(r => parseJ(r.values_json, {}))
      if (args.filtros && typeof args.filtros === 'object') vals = vals.filter(v => rowMatches(v, args.filtros, columns))
      if (args.texto && String(args.texto).trim()) { const needle = norm(args.texto); vals = vals.filter(v => Object.values(v).some(x => norm(x).includes(needle))) }
      const limit = Math.min(30, Math.max(1, Number(args.limite) || 20))
      const shown = vals.slice(0, limit)
      if (!shown.length) return { text: `Sin resultados en "${t.name}".` }
      return { text: `"${t.name}" (${vals.length} coincidencia(s), muestro ${shown.length}):\n${shown.map(v => '• ' + rowToText(v, columns)).join('\n')}` }
    }

    if (fn === 'agregar_fila') {
      if (!args.valores || typeof args.valores !== 'object') return { text: 'Faltan los "valores" de la fila (un objeto columna→valor).' }
      const r = await createRow(accId, t.id, args.valores)
      return { text: `✅ Fila agregada a "${t.name}": ${rowToText(r.values, columns)}` }
    }

    if (fn === 'editar_fila') {
      if (!args.buscar || typeof args.buscar !== 'object') return { text: 'Indica "buscar" (cómo encontrar la fila) y "valores" (qué cambiar).' }
      const [rows] = await pool.query('SELECT * FROM data_table_rows WHERE table_id=? AND account_id=? ORDER BY created_at ASC', [t.id, accId])
      const match = rows.find(r => rowMatches(parseJ(r.values_json, {}), args.buscar, columns))
      if (!match) return { text: `No encontré una fila en "${t.name}" que coincida con ${JSON.stringify(args.buscar)}.` }
      const r = await updateRow(accId, t.id, match.id, args.valores || {})
      return { text: `✅ Fila actualizada en "${t.name}": ${rowToText(r.values, columns)}` }
    }

    if (fn === 'eliminar_fila') {
      if (!args.buscar || typeof args.buscar !== 'object') return { text: 'Indica "buscar" para localizar la fila a eliminar.' }
      const [rows] = await pool.query('SELECT * FROM data_table_rows WHERE table_id=? AND account_id=? ORDER BY created_at ASC', [t.id, accId])
      const matches = rows.filter(r => rowMatches(parseJ(r.values_json, {}), args.buscar, columns))
      if (!matches.length) return { text: `No encontré filas en "${t.name}" que coincidan con ${JSON.stringify(args.buscar)}.` }
      for (const m of matches) await pool.query('DELETE FROM data_table_rows WHERE id=?', [m.id])
      return { text: `🗑 Eliminada(s) ${matches.length} fila(s) de "${t.name}".` }
    }

    return { text: 'Acción de tabla no reconocida.' }
  } catch (e) { return { text: `No se pudo completar la acción en la tabla: ${e.message}` } }
}

module.exports = {
  listTables, getTable, createTable, updateTable, deleteTable,
  listRows, createRow, updateRow, deleteRow,
  publicConfig, toolCall,
}
