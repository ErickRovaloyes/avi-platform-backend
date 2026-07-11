'use strict'
// Portal del cliente (público): el cliente final consulta sus pedidos y reservas por teléfono.
const pool = require('../db')

const _rate = new Map()
function tooMany(ip) {
  const now = Date.now(), win = 60000, max = 30
  const a = (_rate.get(ip) || []).filter(t => now - t < win); a.push(now); _rate.set(ip, a)
  if (_rate.size > 5000) for (const [k, v] of _rate) if (!v.some(t => now - t < win)) _rate.delete(k)
  return a.length > max
}

const portal = async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'ip'
  if (tooMany(ip)) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta en un momento.' })
  const { accId } = req.params
  const phone = String(req.query.phone || '').replace(/[^\d]/g, '')
  if (phone.length < 6) return res.status(400).json({ error: 'Ingresa un número de teléfono válido.' })
  const tail = phone.slice(-8)
  try {
    const [[acc]] = await pool.query('SELECT name FROM accounts WHERE id=?', [accId])
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada.' })
    let businessName = acc.name
    try { const orders = require('../services/orders'); const cfg = orders.normConfig(await orders.loadConfig(accId)); if (cfg.businessName) businessName = cfg.businessName } catch {}

    let orders = []
    try {
      const [rows] = await pool.query("SELECT code, status, type, total, currency, payment_status, created_at, customer_phone FROM orders WHERE account_id=? AND status<>'draft' ORDER BY created_at DESC LIMIT 300", [accId])
      orders = rows
        .filter(r => String(r.customer_phone || '').replace(/[^\d]/g, '').slice(-8) === tail)
        .slice(0, 30)
        .map(o => ({ code: o.code, status: o.status, type: o.type, total: Number(o.total) || 0, currency: o.currency || 'COP', paymentStatus: o.payment_status, createdAt: o.created_at }))
    } catch {}

    let bookings = []
    try {
      const [rows] = await pool.query("SELECT date, time, client_name, status, notes, client_phone FROM calendar_bookings WHERE account_id=? AND client_phone IS NOT NULL AND client_phone<>'' ORDER BY date DESC, time DESC LIMIT 300", [accId])
      bookings = rows
        .filter(r => String(r.client_phone || '').replace(/[^\d]/g, '').slice(-8) === tail)
        .slice(0, 30)
        .map(b => ({ date: b.date, time: b.time, status: b.status, notes: b.notes || '' }))
    } catch {}

    res.json({ businessName, orders, bookings })
  } catch (err) { console.error('[portal]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { portal }
