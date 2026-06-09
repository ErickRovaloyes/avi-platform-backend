'use strict'
/**
 * Analytics (backend port) — registra eventos/conversiones/KPIs/auditoría en la
 * línea de tiempo del CRM (crm_activity) para que aparezcan en dashboard y
 * timelines.
 */

const { interpolate, logDebug } = require('../common')
const { logActivity } = require('../../controllers/crm.controller')

async function logCrmActivity(ctx, { kind, title, detail }) {
  try {
    await logActivity({
      accId: ctx.accId, targetType: 'conversation', targetId: ctx.convId,
      kind, title, detail: detail || '', authorId: null, authorName: 'Flujo',
    })
  } catch {}
}

const analyticsNodes = [
  {
    type: 'analytics_event', category: 'analytics', label: 'Evento analytics',
    async exec(node, ctx) {
      const name = interpolate(node.data?.evento || '', ctx.variables) || 'evento'
      const props = interpolate(node.data?.propiedades || '', ctx.variables)
      await logCrmActivity(ctx, { kind: 'event', title: name, detail: props })
      logDebug(ctx, 'flow_run', `📌 evento: ${name}`, { props })
    },
  },
  {
    type: 'analytics_conversion', category: 'analytics', label: 'Conversión',
    async exec(node, ctx) {
      const name = interpolate(node.data?.nombre || '', ctx.variables) || 'conversion'
      const valor = interpolate(node.data?.valor || '', ctx.variables)
      const moneda = node.data?.moneda || 'USD'
      await logCrmActivity(ctx, { kind: 'conversion', title: name, detail: `${valor} ${moneda}` })
      ctx.variables._last_conversion = { name, value: Number(valor) || 0, currency: moneda }
    },
  },
  {
    type: 'analytics_kpi', category: 'analytics', label: 'KPI',
    async exec(node, ctx) {
      const name = node.data?.kpi
      if (!name) return
      const op = node.data?.operacion || 'inc'
      const val = Number(interpolate(node.data?.valor || '1', ctx.variables)) || 1
      await logCrmActivity(ctx, { kind: 'kpi', title: `${name} ${op} ${val}` })
    },
  },
  {
    type: 'analytics_audit', category: 'analytics', label: 'Auditoría',
    async exec(node, ctx) {
      const accion = interpolate(node.data?.accion || '', ctx.variables) || 'action'
      const detalle = interpolate(node.data?.detalle || '', ctx.variables)
      await logCrmActivity(ctx, { kind: 'audit', title: accion, detail: detalle })
    },
  },
  {
    type: 'analytics_dashboard', category: 'analytics', label: 'Dashboard',
    async exec() { throw new Error('Dashboard externo aún no implementado — usa las Métricas de la plataforma.') },
  },
]

module.exports = { analyticsNodes }
