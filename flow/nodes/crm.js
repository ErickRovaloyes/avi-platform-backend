'use strict'
/**
 * CRM & Leads (backend port) — crear/buscar/actualizar contactos, leads, scoring
 * y marcador de movimiento de pipeline. Acceso directo a la tabla contacts.
 */

const pool = require('../../db')
const { uid, parseJ } = require('../../utils')
const { interpolate, logDebug, setVarBoth } = require('../common')

async function listContacts(accId) {
  const [rows] = await pool.query('SELECT * FROM contacts WHERE account_id=?', [accId])
  return rows.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, createdAt: c.created_at, ...parseJ(c.extra, {}) }))
}

async function createContactRow(accId, { name = '', email = '', phone = '', ...extra }) {
  const id = 'contact_' + uid()
  await pool.query(
    'INSERT INTO contacts (id, account_id, name, email, phone, extra, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, accId, name, email, phone, JSON.stringify(extra || {}), Date.now()]
  )
  return id
}

const crmNodes = [
  {
    type: 'crm_create_contact', category: 'crm', label: 'Crear contacto',
    async exec(node, ctx) {
      const payload = {
        name:        interpolate(node.data?.nombre || '', ctx.variables),
        email:       interpolate(node.data?.email  || '', ctx.variables),
        phone:       interpolate(node.data?.phone  || '', ctx.variables),
        companyName: interpolate(node.data?.company || '', ctx.variables),
        tags: String(node.data?.tags || '').split(',').map(s => s.trim()).filter(Boolean),
      }
      const id = await createContactRow(ctx.accId, payload)
      if (node.data?.destino_id) await setVarBoth(ctx, node.data.destino_id, id)
      ctx.variables._last_contact_id = id
      logDebug(ctx, 'flow_run', `➕ Contacto creado: ${id}`, payload)
    },
  },
  {
    type: 'crm_find_contact', category: 'crm', label: 'Buscar contacto',
    async exec(node, ctx) {
      const all = await listContacts(ctx.accId)
      const value = interpolate(node.data?.valor || '', ctx.variables).toLowerCase()
      const field = node.data?.campo || 'email'
      const m = all.find(c => String(c[field] || '').toLowerCase() === value)
      if (m && node.data?.destino_id) await setVarBoth(ctx, node.data.destino_id, m.id)
      ctx.variables._last_contact_found = !!m
      if (m) Object.assign(ctx.variables, { user_id: m.id, user_name: m.name, user_email: m.email, user_phone: m.phone })
      else throw new Error('Contacto no encontrado')
    },
  },
  {
    type: 'crm_update_contact', category: 'crm', label: 'Actualizar contacto',
    async exec(node, ctx) {
      const id = interpolate(node.data?.contact_id || '{{_last_contact_id}}', ctx.variables)
      if (!id) throw new Error('Falta ID del contacto')
      const sets = []; const vals = []
      const name  = interpolate(node.data?.nombre || '', ctx.variables); if (name)  { sets.push('name=?');  vals.push(name) }
      const email = interpolate(node.data?.email  || '', ctx.variables); if (email) { sets.push('email=?'); vals.push(email) }
      const phone = interpolate(node.data?.phone  || '', ctx.variables); if (phone) { sets.push('phone=?'); vals.push(phone) }
      const raw = interpolate(node.data?.extras || '', ctx.variables)
      if (raw) {
        try {
          const extra = JSON.parse(raw)
          const [[row]] = await pool.query('SELECT extra FROM contacts WHERE id=? AND account_id=?', [id, ctx.accId])
          const merged = { ...parseJ(row?.extra, {}), ...extra }
          sets.push('extra=?'); vals.push(JSON.stringify(merged))
        } catch {}
      }
      if (!sets.length) return
      vals.push(id, ctx.accId)
      await pool.query(`UPDATE contacts SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    },
  },
  {
    type: 'crm_create_lead', category: 'crm', label: 'Crear lead',
    async exec(node, ctx) {
      const id = await createContactRow(ctx.accId, {
        name:  interpolate(node.data?.nombre || '', ctx.variables),
        email: interpolate(node.data?.email  || '', ctx.variables),
        phone: interpolate(node.data?.phone  || '', ctx.variables),
        tags: ['lead', interpolate(node.data?.origen || 'flow', ctx.variables)],
      })
      if (node.data?.destino_id) await setVarBoth(ctx, node.data.destino_id, id)
      ctx.variables._last_lead_id = id
      logDebug(ctx, 'flow_run', `🌟 Lead creado: ${id}`, {})
    },
  },
  {
    type: 'crm_lead_score', category: 'crm', label: 'Lead scoring',
    async exec(node, ctx) {
      const id = interpolate(node.data?.contact_id || '{{_last_lead_id}}', ctx.variables)
      if (!id) throw new Error('Falta contact_id')
      const all = await listContacts(ctx.accId)
      const c = all.find(x => x.id === id)
      if (!c) throw new Error('Contacto no encontrado')
      let score = 0
      if (c.email) score += 25
      if (c.phone) score += 15
      if ((c.tags || []).includes('vip'))  score += 30
      if ((c.tags || []).includes('lead')) score += 10
      const recent = (ctx.variables._last_user_messages || []).length
      score += Math.min(20, recent * 5)
      score = Math.min(100, score)
      if (node.data?.destino) await setVarBoth(ctx, node.data.destino, score)
      ctx.variables._last_lead_score = score
      logDebug(ctx, 'flow_run', `📈 Score: ${score}`, { id })
    },
  },
  {
    // Administra el "ticket" de la conversación: tarjeta de pipeline (deal) o tarea del
    // CRM. Acciones: crear / mover / cerrar. Reutiliza services/tickets.js (misma lógica
    // que el inbox y el motor del navegador). Nodos viejos → tipo 'deal', acción 'mover'.
    type: 'crm_pipeline_move', category: 'crm', label: 'Administrar ticket',
    async exec(node, ctx) {
      const d = node.data || {}
      const tipo = d.tipo || 'deal'
      const accion = d.accion || 'mover'
      const opts = {
        tipo, accion,
        pipelineId: d.pipeline_id || null,
        stageId: d.stage_id || null,
        title: interpolate(d.titulo || '', ctx.variables),
        value: interpolate(d.valor || '', ctx.variables),
        estado: d.estado || 'open',
        assigneeId: d.asignar_a || null,
      }
      if (opts.assigneeId) { const m = (ctx.account?.members || []).find(x => x.id === opts.assigneeId); if (m) opts.assigneeName = m.name }
      try {
        const r = await require('../../services/tickets').applyTicketAction(ctx.accId, ctx.convId, opts)
        ctx.variables._ticket_action = r
        logDebug(ctx, 'flow_run', `🎫 Ticket: ${accion} ${tipo}`, r)
      } catch (e) { logDebug(ctx, 'error', `✗ Ticket no aplicado: ${e.message}`, {}) }
    },
  },
]

module.exports = { crmNodes }
