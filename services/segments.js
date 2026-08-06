'use strict'
// Segmentos dinámicos de contactos: reglas → lista viva de contactos.
// Reutilizable en campañas (masivos) y reportes. Combina datos del contacto con
// estadísticas de pedidos (frecuencia, gasto, recencia).
const pool = require('../db')
const { parseJ } = require('../utils')

const DAY = 86400000

// ¿Alguna regla necesita mirar las conversaciones? Se comprueba antes para no pagar un
// escaneo completo cuando no hace falta: resolveSegment se llama desde el CRM, desde la
// previsualización de cada campaña y en cada envío.
function needsConversations(rules) {
  return !!(rules.lastSeenWithinDays || rules.notSeenWithinDays || (rules.channels || []).length)
}

// Mapa contactId → { lastTs, channels:Set }. Una sola pasada.
//
// 🔴 `conversations` NO tiene columna contact_id: el vínculo vive dentro de local_vars (JSON),
// igual que lo leen conversations.controller.js y flow/store.js. Por eso no hay JOIN posible y
// toca traer las filas y parsear.
async function conversationMap(accId) {
  const map = {}
  try {
    const [rows] = await pool.query(
      'SELECT channel_type, updated_at, local_vars FROM conversations WHERE account_id=?', [accId])
    for (const r of rows) {
      const cid = parseJ(r.local_vars, {})?.contact_id
      if (!cid) continue
      const e = map[cid] || (map[cid] = { lastTs: 0, channels: new Set() })
      const ts = Number(r.updated_at) || 0
      if (ts > e.lastTs) e.lastTs = ts
      if (r.channel_type) e.channels.add(String(r.channel_type))
    }
  } catch { /* sin conversaciones → las reglas que dependan de ellas no encontrarán nada */ }
  return map
}

// Mapa contactId → Set(stageId) a partir de las tarjetas del pipeline (columna JSON `cards`).
async function stageMap(accId) {
  const map = {}
  try {
    const [rows] = await pool.query('SELECT cards FROM pipelines WHERE account_id=?', [accId])
    for (const r of rows) {
      for (const card of (parseJ(r.cards, []) || [])) {
        // `contactId` es el vínculo duro con la ficha; `contact` es solo el nombre mostrado.
        if (!card?.contactId || !card?.stageId) continue
        ;(map[card.contactId] || (map[card.contactId] = new Set())).add(String(card.stageId))
      }
    }
  } catch {}
  return map
}

// Resuelve un segmento a la lista de contactos que cumplen TODAS las reglas.
async function resolveSegment(accId, rules) {
  rules = rules || {}
  const [contacts] = await pool.query('SELECT id, name, phone, email, extra, created_at FROM contacts WHERE account_id=?', [accId])

  // Estadísticas de pedidos por contacto (una sola consulta agregada).
  const os = {}
  try {
    const [rows] = await pool.query(
      "SELECT contact_id, COUNT(*) AS n, COALESCE(SUM(total),0) AS spend, MAX(created_at) AS lastAt FROM orders WHERE account_id=? AND contact_id IS NOT NULL AND status NOT IN('draft','canceled') GROUP BY contact_id",
      [accId])
    for (const r of rows) os[r.contact_id] = { n: Number(r.n), spend: Number(r.spend), lastAt: Number(r.lastAt) }
  } catch {}

  // Solo se consultan si alguna regla los usa: ver needsConversations.
  const convs  = needsConversations(rules) ? await conversationMap(accId) : {}
  const stages = (rules.stageIds || []).length ? await stageMap(accId) : {}

  const now = Date.now()
  const tagsAny  = (rules.tagsAny  || []).map(t => String(t).trim().toLowerCase()).filter(Boolean)
  const stageIds = (rules.stageIds || []).map(String).filter(Boolean)
  const channels = (rules.channels || []).map(String).filter(Boolean)

  return contacts
    .map(c => {
      const ex = parseJ(c.extra, {})
      const s = os[c.id] || { n: 0, spend: 0, lastAt: 0 }
      const cv = convs[c.id] || { lastTs: 0, channels: new Set() }
      return {
        id: c.id, name: c.name || '', email: c.email || '',
        phone: String(c.phone || '').replace(/[^\d]/g, ''),
        tags: (ex.tags || []).map(x => String(x).toLowerCase()),
        optOut: ex.optOut === true || ex.optOut === 1,
        createdAt: Number(c.created_at) || 0,
        orders: s.n, spend: s.spend, lastOrderAt: s.lastAt,
        lastSeenAt: cv.lastTs, channels: cv.channels,
        stages: stages[c.id] || new Set(),
      }
    })
    .filter(c => {
      if (rules.subscribedOnly && c.optOut) return false
      if (rules.requirePhone && !c.phone) return false
      if (tagsAny.length && !c.tags.some(t => tagsAny.includes(t))) return false
      if (rules.createdWithinDays && (now - c.createdAt) > rules.createdWithinDays * DAY) return false
      if (rules.minOrders && c.orders < Number(rules.minOrders)) return false
      if (rules.minSpend && c.spend < Number(rules.minSpend)) return false
      if (rules.purchasedWithinDays && (!c.lastOrderAt || (now - c.lastOrderAt) > rules.purchasedWithinDays * DAY)) return false
      if (rules.notPurchasedWithinDays && c.lastOrderAt && (now - c.lastOrderAt) <= rules.notPurchasedWithinDays * DAY) return false
      // Etapa del pipeline: basta estar en UNA de las elegidas (un contacto puede tener varias
      // oportunidades abiertas en etapas distintas).
      if (stageIds.length && !stageIds.some(id => c.stages.has(id))) return false
      // Última interacción. Sin conversaciones, lastSeenAt = 0: "activo en N días" lo excluye y
      // "sin actividad en N días" lo incluye, que es lo que se espera de un contacto frío.
      if (rules.lastSeenWithinDays && (!c.lastSeenAt || (now - c.lastSeenAt) > rules.lastSeenWithinDays * DAY)) return false
      if (rules.notSeenWithinDays && c.lastSeenAt && (now - c.lastSeenAt) <= rules.notSeenWithinDays * DAY) return false
      // Canal de origen: alguna de sus conversaciones llegó por uno de los canales pedidos.
      if (channels.length && !channels.some(ch => c.channels.has(ch))) return false
      return true
    })
    // Los Set no sobreviven a JSON.stringify y se enviarían como {}. Se quitan: son detalle
    // interno del filtrado, no parte del contacto.
    .map(({ channels: _c, stages: _s, ...rest }) => rest)
}

module.exports = { resolveSegment, needsConversations }
