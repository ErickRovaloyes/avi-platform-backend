'use strict'
/**
 * Google Sheets node — consume/inserta/edita/elimina filas usando la cuenta de
 * Google conectada (OAuth). El "spreadsheet" puede ser el link de la hoja o su id.
 */

const { interpolate, logDebug, safeJson, setVarBoth } = require('../common')
const g = require('../../services/google')

function parseValues(raw, vars) {
  const txt = interpolate(raw || '', vars)
  if (!txt.trim()) return []
  const trimmed = txt.trim()
  if (trimmed.startsWith('[')) { const a = safeJson(trimmed, null); if (Array.isArray(a)) return a.map(String) }
  return trimmed.split(',').map(s => s.trim())
}

const googleNodes = [
  {
    type: 'google_sheets', category: 'integrations', label: 'Google Sheets', timeoutMs: 30000,
    fields: [
      { key: 'operacion', label: 'Operación', type: 'select', options: [
          { value: 'read',   label: 'Consumir filas (leer)' },
          { value: 'append', label: 'Agregar fila' },
          { value: 'update', label: 'Editar fila (rango)' },
          { value: 'delete', label: 'Eliminar contenido (rango)' },
        ], default: 'read' },
      { key: 'spreadsheet', label: 'Link o ID de la hoja', type: 'text', placeholder: 'https://docs.google.com/spreadsheets/d/...' },
      { key: 'range', label: 'Rango', type: 'text', placeholder: 'Hoja1!A1:Z100  ·  Hoja1!A2:D2  ·  Hoja1!A:A' },
      { key: 'valores', label: 'Valores (coma o JSON, para agregar/editar)', type: 'textarea', placeholder: '{{nombre}}, {{email}}, nuevo' },
      { key: 'destino', label: 'Guardar resultado en (al leer)', type: 'variableRef' },
    ],
    async exec(node, ctx) {
      const op = node.data?.operacion || 'read'
      const spreadsheetId = g.extractSpreadsheetId(interpolate(node.data?.spreadsheet || '', ctx.variables))
      const range = interpolate(node.data?.range || '', ctx.variables) || 'A1:Z1000'
      if (!spreadsheetId) throw new Error('Falta el link/ID de la hoja')

      const token = await g.getValidAccessToken(ctx.accId)

      if (op === 'read') {
        const rows = await g.readRows(token, spreadsheetId, range)
        if (node.data?.destino) await setVarBoth(ctx, node.data.destino, JSON.stringify(rows))
        ctx.variables._last_sheet_rows = rows
        logDebug(ctx, 'flow_run', `📊 Sheets leído: ${rows.length} fila(s)`, { range })
      } else if (op === 'append') {
        const values = parseValues(node.data?.valores, ctx.variables)
        await g.appendRow(token, spreadsheetId, range, values)
        logDebug(ctx, 'flow_run', `📊 Fila agregada (${values.length} col)`, { range })
      } else if (op === 'update') {
        const values = parseValues(node.data?.valores, ctx.variables)
        await g.updateRange(token, spreadsheetId, range, values)
        logDebug(ctx, 'flow_run', `📊 Rango actualizado`, { range })
      } else if (op === 'delete') {
        await g.clearRange(token, spreadsheetId, range)
        logDebug(ctx, 'flow_run', `📊 Rango limpiado`, { range })
      }
    },
  },
]

module.exports = { googleNodes }
