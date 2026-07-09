'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const socket = require('../services/socket')
const orders = require('../services/orders')

// ── Config ─────────────────────────────────────────────────────────────────────
const getConfig = async (req, res) => {
  try {
    const cfg = orders.normConfig(await orders.loadConfig(req.params.accId))
    res.json(cfg)
  } catch { res.status(500).json({ error: 'Error interno' }) }
}
const saveConfig = async (req, res) => {
  const { accId } = req.params
  try {
    const cur = orders.normConfig(await orders.loadConfig(accId))
    const b = req.body || {}
    const next = { ...cur }
    for (const k of ['enabled', 'orderTypes', 'currency', 'taxPct', 'packagingFee', 'minOrder', 'freeDeliveryThreshold', 'paymentMethods', 'notifyTeam', 'postOrderFlowId', 'tips', 'businessName']) {
      if (b[k] !== undefined) next[k] = b[k]
    }
    await orders.saveConfig(accId, orders.normConfig(next))
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true, config: orders.normConfig(next) })
  } catch (e) { console.error('[orders saveConfig]', e); res.status(500).json({ error: 'Error interno' }) }
}

// ── Menú: productos ─────────────────────────────────────────────────────────────
const listMenu = async (req, res) => {
  try {
    const [products, groups, zones, couriers] = await Promise.all([
      orders.listProducts(req.params.accId), orders.listGroups(req.params.accId),
      orders.listZones(req.params.accId), orders.listCouriers(req.params.accId),
    ])
    res.json({ products, groups, zones, couriers })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}
const saveProduct = async (req, res) => {
  const { accId } = req.params; const b = req.body || {}
  try {
    const id = b.id || ('op_' + uid())
    const vals = { category: String(b.category || '').slice(0, 120), name: String(b.name || '').slice(0, 200), description: String(b.description || ''), price: Number(b.price) || 0, media_id: b.mediaId || null, image_url: String(b.imageUrl || ''), modifier_group_ids: JSON.stringify(Array.isArray(b.modifierGroupIds) ? b.modifierGroupIds : []), available: b.available === false ? 0 : 1, sort: Number(b.sort) || 0 }
    if (b.id) {
      const sets = Object.keys(vals).map(k => `${k}=?`).join(','); await pool.query(`UPDATE order_products SET ${sets} WHERE id=? AND account_id=?`, [...Object.values(vals), id, accId])
    } else {
      await pool.query('INSERT INTO order_products (id,account_id,category,name,description,price,media_id,image_url,modifier_group_ids,available,sort,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, accId, vals.category, vals.name, vals.description, vals.price, vals.media_id, vals.image_url, vals.modifier_group_ids, vals.available, vals.sort, 'menu', Date.now()])
    }
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true, id })
  } catch (e) { console.error('[orders saveProduct]', e); res.status(500).json({ error: 'Error interno' }) }
}
const deleteProduct = async (req, res) => {
  try { await pool.query('DELETE FROM order_products WHERE id=? AND account_id=?', [req.params.id, req.params.accId]); socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId }); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// ── Menú: grupos de modificadores + modificadores ───────────────────────────────
const saveGroup = async (req, res) => {
  const { accId } = req.params; const b = req.body || {}
  try {
    const id = b.id || ('omg_' + uid())
    if (b.id) await pool.query('UPDATE order_modifier_groups SET name=?, min_select=?, max_select=?, required=?, sort=? WHERE id=? AND account_id=?',
      [String(b.name || '').slice(0, 160), Number(b.minSelect) || 0, Number(b.maxSelect) || 1, b.required ? 1 : 0, Number(b.sort) || 0, id, accId])
    else await pool.query('INSERT INTO order_modifier_groups (id,account_id,name,min_select,max_select,required,sort,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, accId, String(b.name || '').slice(0, 160), Number(b.minSelect) || 0, Number(b.maxSelect) || 1, b.required ? 1 : 0, Number(b.sort) || 0, Date.now()])
    // Reemplaza los modificadores del grupo.
    if (Array.isArray(b.modifiers)) {
      await pool.query('DELETE FROM order_modifiers WHERE group_id=? AND account_id=?', [id, accId])
      let i = 0
      for (const m of b.modifiers) {
        if (!m || !String(m.name || '').trim()) continue
        await pool.query('INSERT INTO order_modifiers (id,group_id,account_id,name,price_delta,available,sort) VALUES (?,?,?,?,?,?,?)',
          ['om_' + uid(), id, accId, String(m.name).slice(0, 160), Number(m.priceDelta) || 0, m.available === false ? 0 : 1, i++])
      }
    }
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true, id })
  } catch (e) { console.error('[orders saveGroup]', e); res.status(500).json({ error: 'Error interno' }) }
}
const deleteGroup = async (req, res) => {
  try { await pool.query('DELETE FROM order_modifier_groups WHERE id=? AND account_id=?', [req.params.id, req.params.accId]); await pool.query('DELETE FROM order_modifiers WHERE group_id=? AND account_id=?', [req.params.id, req.params.accId]); socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId }); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// ── Zonas de entrega ────────────────────────────────────────────────────────────
const saveZone = async (req, res) => {
  const { accId } = req.params; const b = req.body || {}
  try {
    const id = b.id || ('oz_' + uid())
    if (b.id) await pool.query('UPDATE order_zones SET name=?, fee=?, min_order=?, eta_min=?, sort=? WHERE id=? AND account_id=?',
      [String(b.name || '').slice(0, 160), Number(b.fee) || 0, Number(b.minOrder) || 0, Number(b.etaMin) || 0, Number(b.sort) || 0, id, accId])
    else await pool.query('INSERT INTO order_zones (id,account_id,name,fee,min_order,eta_min,sort,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, accId, String(b.name || '').slice(0, 160), Number(b.fee) || 0, Number(b.minOrder) || 0, Number(b.etaMin) || 0, Number(b.sort) || 0, Date.now()])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true, id })
  } catch (e) { console.error('[orders saveZone]', e); res.status(500).json({ error: 'Error interno' }) }
}
const deleteZone = async (req, res) => {
  try { await pool.query('DELETE FROM order_zones WHERE id=? AND account_id=?', [req.params.id, req.params.accId]); socket.emit(req.params.accId, 'account:updated', { accId: req.params.accId }); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// ── Repartidores ────────────────────────────────────────────────────────────────
const saveCourier = async (req, res) => {
  const { accId } = req.params; const b = req.body || {}
  try {
    const id = b.id || ('ocr_' + uid())
    if (b.id) await pool.query('UPDATE order_couriers SET name=?, phone=?, active=? WHERE id=? AND account_id=?', [String(b.name || '').slice(0, 160), String(b.phone || '').slice(0, 40), b.active === false ? 0 : 1, id, accId])
    else await pool.query('INSERT INTO order_couriers (id,account_id,name,phone,active,created_at) VALUES (?,?,?,?,?,?)', [id, accId, String(b.name || '').slice(0, 160), String(b.phone || '').slice(0, 40), b.active === false ? 0 : 1, Date.now()])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true, id })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}
const deleteCourier = async (req, res) => {
  try { await pool.query('DELETE FROM order_couriers WHERE id=? AND account_id=?', [req.params.id, req.params.accId]); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// ── Tablero de pedidos (operativo) ──────────────────────────────────────────────
const listOrders = async (req, res) => {
  const { accId } = req.params
  try {
    const status = req.query.status
    let sql = "SELECT * FROM orders WHERE account_id=? AND status<>'draft'"
    const vals = [accId]
    if (status && status !== 'all') { sql += ' AND status=?'; vals.push(status) }
    sql += ' ORDER BY created_at DESC LIMIT 200'
    const [rows] = await pool.query(sql, vals)
    res.json({ orders: rows.map(orders.mapOrder) })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}
const getOrder = async (req, res) => {
  try { const [[o]] = await pool.query('SELECT * FROM orders WHERE id=? AND account_id=?', [req.params.id, req.params.accId]); if (!o) return res.status(404).json({ error: 'No encontrado' }); res.json(orders.mapOrder(o)) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}
const updateOrder = async (req, res) => {
  const { accId, id } = req.params; const b = req.body || {}
  try {
    const [[o]] = await pool.query('SELECT * FROM orders WHERE id=? AND account_id=?', [id, accId])
    if (!o) return res.status(404).json({ error: 'No encontrado' })
    const sets = [], vals = []
    if (b.status && orders.STATUSES.includes(b.status)) {
      sets.push('status=?'); vals.push(b.status)
      const tl = parseJ(o.timeline, []); tl.push({ status: b.status, at: Date.now(), by: req.user?.name || 'equipo' }); sets.push('timeline=?'); vals.push(JSON.stringify(tl))
    }
    if (b.courierId !== undefined) { sets.push('courier_id=?'); vals.push(b.courierId || null) }
    if (b.paymentStatus !== undefined) { sets.push('payment_status=?'); vals.push(b.paymentStatus) }
    if (!sets.length) return res.json({ ok: true })
    sets.push('updated_at=?'); vals.push(Date.now(), id, accId)
    await pool.query(`UPDATE orders SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'orders:updated', { accId })
    res.json({ ok: true })
  } catch (e) { console.error('[orders updateOrder]', e); res.status(500).json({ error: 'Error interno' }) }
}

// ── Proxy del asistente (público, rate-limited) ─────────────────────────────────
const _rate = new Map()
function tooMany(ip) { const now = Date.now(), win = 60000, max = 60; const a = (_rate.get(ip) || []).filter(t => now - t < win); a.push(now); _rate.set(ip, a); if (_rate.size > 5000) for (const [k, v] of _rate) if (!v.some(t => now - t < win)) _rate.delete(k); return a.length > max }
const tool = async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'ip'
  if (tooMany(ip)) return res.status(429).json({ error: 'Demasiadas solicitudes.' })
  try {
    const { fn, args, convId, agId } = req.body || {}
    const r = await orders.toolCall(req.params.accId, fn, args || {}, { convId, agId })
    res.json({ text: r.text, media: r.media || [], ordered: !!r.ordered, orderCode: r.orderCode || '', paymentUrl: r.paymentUrl || '' })
  } catch (e) { res.status(400).json({ error: e.message }) }
}

module.exports = {
  getConfig, saveConfig, listMenu, saveProduct, deleteProduct, saveGroup, deleteGroup,
  saveZone, deleteZone, saveCourier, deleteCourier, listOrders, getOrder, updateOrder, tool,
}
