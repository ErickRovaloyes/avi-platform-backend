'use strict'
/**
 * Mensajes masivos (campañas). Una campaña ejecuta un FLUJO (que contiene la
 * plantilla de WhatsApp) sobre una audiencia filtrada de contactos. Puede enviarse
 * ya o programarse para una fecha. Reutiliza el motor de flujos + la entrega de
 * WhatsApp de calendarNotify (buildOutbound / resolveWhatsAppChannel).
 */
const pool = require('../db')
const { parseJ } = require('../utils')
const store = require('../flow/store')
const engine = require('../flow/engine')
const { resolveWhatsAppChannel, buildOutbound } = require('./calendarNotify')

// Audiencia: contactos con teléfono, opcionalmente filtrados por etiquetas (any-of).
async function resolveAudience(accId, audience) {
  const [rows] = await pool.query('SELECT id, name, phone, extra FROM contacts WHERE account_id=?', [accId])
  const tags = (audience?.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean)
  return rows
    .map(r => ({
      id: r.id, name: r.name || '',
      phone: String(r.phone || '').replace(/[^\d]/g, ''),
      tags: (parseJ(r.extra, {}).tags || []).map(x => String(x).toLowerCase()),
    }))
    .filter(r => r.phone)
    .filter(r => !tags.length || r.tags.some(t => tags.includes(t)))
}

async function audienceCount(accId, audience) {
  return (await resolveAudience(accId, audience)).length
}

// Ejecuta una campaña: corre el flujo por cada contacto de la audiencia.
async function runCampaign(campaignId) {
  const [[c]] = await pool.query('SELECT * FROM campaigns WHERE id=?', [campaignId])
  if (!c) return { error: 'no encontrada' }
  if (['sending', 'done', 'cancelled'].includes(c.status)) return { error: 'estado no ejecutable: ' + c.status }
  await pool.query('UPDATE campaigns SET status=? WHERE id=?', ['sending', campaignId])

  const accId = c.account_id, agId = c.agent_id, flowId = c.flow_id
  const audience = parseJ(c.audience, {})
  let sent = 0, failed = 0, total = 0
  try {
    const contacts = await resolveAudience(accId, audience)
    total = contacts.length
    const account = await store.loadAccount(accId)
    const agent = account?.agents?.find(a => a.id === agId)
    const channel = await resolveWhatsAppChannel(accId, agId)
    if (!agent || !channel) {
      failed = total
    } else {
      for (const ct of contacts) {
        try {
          const convId = await store.createOrGetWhatsAppConvo(accId, agId, ct.phone, ct.name || ct.phone, channel.id)
          const outbound = buildOutbound(agent, 'whatsapp', channel.id, ct.phone)
          const triggerContext = {
            message: '', _campaign: c.name || '',
            cliente_nombre: ct.name || '', cliente_telefono: ct.phone, contact_id: ct.id,
          }
          await engine.executeFlow({ flowId, accId, agId, convId, triggerContext, triggeredBy: { type: 'campaign' }, outbound })
          sent++
        } catch (e) { failed++; console.warn('[campaign]', ct.phone, e.message) }
        await new Promise(r => setTimeout(r, 350)) // respiro anti rate-limit de Meta
      }
    }
  } catch (e) {
    console.error('[runCampaign]', e.message)
  }
  await pool.query('UPDATE campaigns SET status=?, stats=?, sent_at=? WHERE id=?',
    ['done', JSON.stringify({ total, sent, failed }), Date.now(), campaignId])
  return { total, sent, failed }
}

// Worker: procesa campañas programadas vencidas (cada minuto).
async function processScheduled() {
  try {
    const now = Date.now()
    const [rows] = await pool.query(
      "SELECT id FROM campaigns WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<=? LIMIT 5", [now]
    )
    for (const r of rows) await runCampaign(r.id)
  } catch (e) { console.warn('[campaigns worker]', e.message) }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(processScheduled, 60 * 1000)
  setTimeout(processScheduled, 8000)
}

module.exports = { resolveAudience, audienceCount, runCampaign, processScheduled, startWorker }
