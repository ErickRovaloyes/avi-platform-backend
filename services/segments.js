'use strict'
// Segmentos dinámicos de contactos: reglas → lista viva de contactos.
// Reutilizable en campañas (masivos) y reportes. Combina datos del contacto con
// estadísticas de pedidos (frecuencia, gasto, recencia).
const pool = require('../db')
const { parseJ } = require('../utils')

const DAY = 86400000

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

  const now = Date.now()
  const tagsAny = (rules.tagsAny || []).map(t => String(t).trim().toLowerCase()).filter(Boolean)

  return contacts
    .map(c => {
      const ex = parseJ(c.extra, {})
      const s = os[c.id] || { n: 0, spend: 0, lastAt: 0 }
      return {
        id: c.id, name: c.name || '', email: c.email || '',
        phone: String(c.phone || '').replace(/[^\d]/g, ''),
        tags: (ex.tags || []).map(x => String(x).toLowerCase()),
        optOut: ex.optOut === true || ex.optOut === 1,
        createdAt: Number(c.created_at) || 0,
        orders: s.n, spend: s.spend, lastOrderAt: s.lastAt,
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
      return true
    })
}

module.exports = { resolveSegment }
