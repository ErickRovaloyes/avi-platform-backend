'use strict'
/**
 * Google Sheets node — acciones de alto nivel sobre una hoja vinculada usando la
 * cuenta de Google conectada (OAuth). Mismo comportamiento que el endpoint
 * server-side (pruebas/webchat): se apoya en g.runSheetsOperation.
 *
 * Acciones:
 *   read   → Obtener múltiples filas (con filtros + consumir columnas a variables)
 *   send   → Enviar datos (agregar fila a partir de "campos a enviar")
 *   update → Actualizar la primera fila que coincide con los filtros
 *   delete → Eliminar el contenido de la fila que coincide con los filtros
 */

const { interpolate, logDebug, setVarBoth } = require('../common')
const g = require('../../services/google')

// filters: [{column, value}] con value interpolado
function buildFilters(node, ctx) {
  return (Array.isArray(node.data?.filters) ? node.data.filters : [])
    .filter(f => f && String(f.column ?? '').trim() !== '')
    .map(f => ({ column: f.column, value: interpolate(f.value || '', ctx.variables) }))
}

// fieldMap: { columna: valorInterpolado } a partir de "campos a enviar"
function buildFieldMap(node, ctx) {
  const out = {}
  for (const m of (Array.isArray(node.data?.fields) ? node.data.fields : [])) {
    if (!m || String(m.column ?? '').trim() === '') continue
    out[m.column] = interpolate(m.value || '', ctx.variables)
  }
  return out
}

const googleNodes = [
  {
    type: 'google_sheets', category: 'integrations', label: 'Google Sheets', timeoutMs: 30000,
    fields: [
      { key: 'operacion', label: 'Acciones', type: 'select', options: [
          { value: 'read',   label: 'Obtener múltiples filas' },
          { value: 'send',   label: 'Enviar datos (agregar fila)' },
          { value: 'update', label: 'Actualizar fila' },
          { value: 'delete', label: 'Eliminar fila' },
        ], default: 'read' },
      { key: 'sheetId', label: 'Hoja de cálculo', type: 'sheetRef' },
      { key: 'spreadsheet', label: '…o link/ID de la hoja', type: 'text', placeholder: 'https://docs.google.com/spreadsheets/d/...' },
      { key: 'worksheet', label: 'Hoja de trabajo', type: 'worksheetRef' },
      { key: 'filters', label: 'Campos a filtrar (Lookup Columns)', type: 'sheetFilters' },
      { key: 'fields',  label: 'Campos a enviar', type: 'sheetFieldMap' },
      { key: 'consume', label: 'Campos a consumir → variables', type: 'sheetConsumeMap' },
      { key: 'limit', label: 'Número máximo de filas a devolver', type: 'number', default: 10 },
      { key: 'destino', label: 'Guardar filas encontradas en (JSON)', type: 'variableRef' },
    ],
    async exec(node, ctx) {
      const op = node.data?.operacion || 'read'
      const rawSheet = (node.data?.sheetId && String(node.data.sheetId).trim())
        || interpolate(node.data?.spreadsheet || '', ctx.variables)
      const spreadsheetId = g.extractSpreadsheetId(rawSheet)
      if (!spreadsheetId) throw new Error('Elige una hoja de cálculo')
      const worksheet = node.data?.worksheet || ''
      const range = interpolate(node.data?.range || '', ctx.variables)

      const token = await g.getValidAccessToken(ctx.accId)
      const filters  = buildFilters(node, ctx)
      const fieldMap = buildFieldMap(node, ctx)
      const limit    = Number(node.data?.limit) || 0

      const out = await g.runSheetsOperation(token, {
        operation: op, spreadsheetId, worksheet, range, filters, fieldMap, limit,
      })
      if (out?.error) throw new Error(out.error)

      if (op === 'read' || op === 'get_rows') {
        const records = out.records || []
        if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(records))
        ctx.variables._last_sheet_rows = out.rows || []
        ctx.variables._last_sheet_records = records
        ctx.variables._last_sheet_count = records.length
        // Campos a consumir: columna → variable (de la 1ª fila encontrada)
        const consume = Array.isArray(node.data?.consume) ? node.data.consume : []
        const first = records[0] || {}
        for (const m of consume) {
          if (!m?.column || !m?.var) continue
          const key = Object.keys(first).find(k => k.toLowerCase() === String(m.column).toLowerCase())
          await setVarBoth(ctx, m.var, key != null ? (first[key] ?? '') : '')
        }
        logDebug(ctx, 'flow_run', `📊 Sheets: ${records.length} fila(s)`, { worksheet, filters })
      } else if (op === 'send') {
        logDebug(ctx, 'flow_run', `📊 Fila agregada`, { worksheet })
      } else if (op === 'update') {
        logDebug(ctx, 'flow_run', `📊 Fila ${out.row} actualizada`, { worksheet })
      } else if (op === 'delete') {
        logDebug(ctx, 'flow_run', `📊 Fila ${out.cleared} eliminada`, { worksheet })
      }
    },
  },
]

module.exports = { googleNodes }
