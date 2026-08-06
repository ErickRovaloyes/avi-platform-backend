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

/**
 * Audiencia de una campaña.
 *
 *   { segmentId }   → segmento guardado del CRM
 *   { rules }       → filtro a medida, con el MISMO vocabulario que un segmento
 *   { tags }        → legado: se traduce a `rules.tagsAny`
 *   { contactIds }  → lista FIJA elegida a mano; manda sobre todo lo anterior
 *   { excludeIds }  → contactos desmarcados; se restan SIEMPRE, sea cual sea la base
 *
 * Todo el filtrado lo hace `segments.resolveSegment`. Antes esta función tenía su propio
 * filtro de etiquetas, con un código distinto al del CRM: dos motores sobre los mismos datos
 * acaban divergiendo, y entonces la campaña envía a una lista que no es la que el CRM enseña.
 *
 * `requirePhone` y `subscribedOnly` se fuerzan SIEMPRE, incluso con `contactIds`: que alguien
 * haya marcado un contacto a mano no puede saltarse una baja — eso es cumplimiento, no una
 * preferencia de la interfaz.
 */
async function resolveAudience(accId, audience) {
  const a = audience || {}
  let rules = null

  if (a.segmentId) {
    try {
      const [[seg]] = await pool.query('SELECT rules FROM contact_segments WHERE id=? AND account_id=?', [a.segmentId, accId])
      if (seg) rules = parseJ(seg.rules, {})
    } catch {}
  }
  if (!rules && a.rules && typeof a.rules === 'object') rules = { ...a.rules }
  if (!rules) rules = {}
  // Compatibilidad con las campañas ya guardadas, que llevan `tags` sueltas.
  const legacyTags = (a.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean)
  if (legacyTags.length && !(rules.tagsAny || []).length) rules.tagsAny = legacyTags

  const list = await require('./segments').resolveSegment(accId, { ...rules, requirePhone: true, subscribedOnly: true })

  // La lista fija acota; no amplía. Un id inventado, de otra cuenta o de alguien dado de baja
  // no entra, porque solo puede seleccionar dentro de lo que ya pasó el filtro.
  const only = (a.contactIds || []).length ? new Set(a.contactIds.map(String)) : null
  const out  = new Set((a.excludeIds || []).map(String))

  return list
    .filter(c => (!only || only.has(String(c.id))) && !out.has(String(c.id)))
    .map(c => ({ id: c.id, name: c.name, phone: c.phone, tags: c.tags }))
}

async function audienceCount(accId, audience) {
  return (await resolveAudience(accId, audience)).length
}

// Auto opt-out: si el cliente escribe una palabra de baja, se marca para no recibir masivos.
const OPTOUT_RE = /^\s*(baja|stop|cancelar|desuscribir|desuscribirme|unsubscribe|no\s*mas|no\s*más|no\s*mensajes|no\s*quiero\s*mensajes|salir)\b/i
async function maybeOptOut(accId, phone, text) {
  try {
    if (!text || !OPTOUT_RE.test(String(text))) return false
    const p = String(phone || '').replace(/[^\d]/g, '')
    if (p.length < 6) return false
    const tail = p.slice(-8)
    const [rows] = await pool.query('SELECT id, phone, extra FROM contacts WHERE account_id=?', [accId])
    let changed = false
    for (const r of rows) {
      const rp = String(r.phone || '').replace(/[^\d]/g, '')
      if (rp && rp.slice(-8) === tail) {
        const ex = parseJ(r.extra, {})
        if (!ex.optOut) { ex.optOut = true; ex.optOutAt = Date.now(); ex.optOutBy = 'cliente'; await pool.query('UPDATE contacts SET extra=? WHERE id=?', [JSON.stringify(ex), r.id]); changed = true }
      }
    }
    return changed
  } catch { return false }
}

// Ejecuta una campaña: corre el flujo por cada contacto de la audiencia.
async function runCampaign(campaignId) {
  const [[c]] = await pool.query('SELECT * FROM campaigns WHERE id=?', [campaignId])
  if (!c) return { error: 'no encontrada' }
  if (['sending', 'done', 'cancelled'].includes(c.status)) return { error: 'estado no ejecutable: ' + c.status }
  await pool.query('UPDATE campaigns SET status=? WHERE id=?', ['sending', campaignId])

  const accId = c.account_id, agId = c.agent_id, flowId = c.flow_id
  const audience = parseJ(c.audience, {})
  // A/B testing: si hay flujo variante, se reparte la audiencia (ab_split % → B, resto → A).
  const variantFlowId = c.variant_flow_id || null
  const abSplit = Math.min(Math.max(parseInt(c.ab_split) || 50, 5), 95)
  const abGroups = { a: { contacts: [], convos: [] }, b: { contacts: [], convos: [] } }
  let sent = 0, failed = 0, total = 0
  const recipients = []
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
        // Reparto A/B (equilibra: si B va rezagado y aún cabe, empuja a B).
        const grp = variantFlowId ? (Math.random() * 100 < abSplit ? 'b' : 'a') : 'a'
        const useFlow = grp === 'b' ? variantFlowId : flowId
        try {
          const convId = await store.createOrGetWhatsAppConvo(accId, agId, ct.phone, ct.name || ct.phone, channel.id)
          const outbound = buildOutbound(agent, 'whatsapp', channel.id, ct.phone)
          const triggerContext = {
            message: '', _campaign: c.name || '', _abVariant: variantFlowId ? grp : '',
            cliente_nombre: ct.name || '', cliente_telefono: ct.phone, contact_id: ct.id,
          }
          await engine.executeFlow({ flowId: useFlow, accId, agId, convId, triggerContext, triggeredBy: { type: 'campaign', campaignId: c.id }, outbound })
          sent++; if (ct.id) recipients.push(ct.id)
          if (variantFlowId) { if (ct.id) abGroups[grp].contacts.push(ct.id); if (convId) abGroups[grp].convos.push(convId) }
        } catch (e) { failed++; console.warn('[campaign]', ct.phone, e.message) }
        await new Promise(r => setTimeout(r, 350)) // respiro anti rate-limit de Meta
      }
    }
  } catch (e) {
    console.error('[runCampaign]', e.message)
  }
  await pool.query('UPDATE campaigns SET status=?, stats=?, sent_at=?, recipients=?, ab_groups=? WHERE id=?',
    ['done', JSON.stringify({ total, sent, failed, delivered: 0, read: 0, responded: 0 }), Date.now(), JSON.stringify(recipients), variantFlowId ? JSON.stringify(abGroups) : null, campaignId])
  // Primer recálculo (los webhooks de estado irán actualizando entregados/leídos).
  try { await store.recountCampaignStats(campaignId) } catch {}
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

module.exports = { resolveAudience, audienceCount, maybeOptOut, runCampaign, processScheduled, startWorker }
