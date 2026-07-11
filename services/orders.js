'use strict'
/**
 * Módulo Pedidos y Domicilios — Fase 1.
 * Herramienta IA Especial "pedidos": el asistente muestra el menú, arma el pedido
 * (carrito = pedido en estado 'draft' por conversación), captura el tipo de entrega
 * y datos, calcula totales + costo de envío por zona, genera el pago (link Wompi o
 * contra entrega) y crea el pedido. Además: seguimiento por código.
 * Panel operativo y repartidores: controllers/orders + fases siguientes.
 * Todo corre en el servidor (patrón idéntico a scheduling/pms).
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const socket = require('./socket')
const { sendBotMsg } = require('../flow/common')
const { buildOutbound } = require('./calendarNotify')

const ORDER_TYPES = ['delivery', 'pickup', 'dinein', 'scheduled']
const TYPE_LABEL = { delivery: 'domicilio', pickup: 'para recoger', dinein: 'en el local', scheduled: 'programado' }
// Ciclo de vida de un pedido (el tablero operativo los mueve entre estados).
const STATUSES = ['draft', 'received', 'confirmed', 'preparing', 'ready', 'on_the_way', 'delivered', 'canceled']
const STATUS_LABEL = { received: 'recibido', confirmed: 'confirmado', preparing: 'en preparación', ready: 'listo', on_the_way: 'en camino', delivered: 'entregado', canceled: 'cancelado' }
const EXTERNAL_CHANNELS = new Set(['whatsapp', 'messenger', 'instagram'])
// Plantillas por estado que se avisan al cliente (editables en la config).
const STATUS_MSG_DEFAULT = {
  confirmed:  '✅ ¡Tu pedido {code} fue confirmado! Ya lo empezamos a preparar.',
  preparing:  '👨‍🍳 Tu pedido {code} está en preparación.',
  ready:      '📦 Tu pedido {code} ya está listo.',
  on_the_way: '🛵 ¡Tu pedido {code} va en camino!',
  delivered:  '🎉 Tu pedido {code} fue entregado. ¡Gracias por tu compra!',
  canceled:   '❌ Tu pedido {code} fue cancelado. Cualquier duda, escríbenos.',
}

// ── Config por cuenta ──────────────────────────────────────────────────────────
async function loadConfig(accId) {
  try { const [[a]] = await pool.query('SELECT orders FROM accounts WHERE id=?', [accId]); return parseJ(a?.orders, null) }
  catch { return null }
}
async function saveConfig(accId, cfg) { await pool.query('UPDATE accounts SET orders=? WHERE id=?', [JSON.stringify(cfg || {}), accId]) }

async function hasMenu(accId) {
  try { const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM order_products WHERE account_id=? AND available=1', [accId]); return (r?.n || 0) > 0 }
  catch { return false }
}

function normConfig(cfg) {
  const c = cfg || {}
  const types = Array.isArray(c.orderTypes) && c.orderTypes.length ? c.orderTypes.filter(t => ORDER_TYPES.includes(t)) : ['delivery', 'pickup']
  return {
    enabled: c.enabled !== false,
    orderTypes: types,
    currency: c.currency || 'COP',
    taxPct: Number(c.taxPct) || 0,
    packagingFee: Number(c.packagingFee) || 0,
    minOrder: Number(c.minOrder) || 0,
    freeDeliveryThreshold: Number(c.freeDeliveryThreshold) || 0,
    paymentMethods: Array.isArray(c.paymentMethods) && c.paymentMethods.length ? c.paymentMethods : ['online', 'cash'],
    notifyTeam: c.notifyTeam !== false,
    postOrderFlowId: c.postOrderFlowId || '',
    tips: Array.isArray(c.tips) ? c.tips : [0, 10, 15],
    businessName: c.businessName || '',
    // Avisar al cliente por su canal cuando cambia el estado del pedido.
    notifyCustomer: c.notifyCustomer !== false,
    statusMessages: (c.statusMessages && typeof c.statusMessages === 'object' && !Array.isArray(c.statusMessages)) ? c.statusMessages : {},
    // Reseña automática al entregar el pedido (Google/redes).
    reviewEnabled: !!c.reviewEnabled,
    reviewUrl: c.reviewUrl || '',
    reviewMessage: c.reviewMessage || '🌟 ¿Nos ayudas con una reseña? Cuéntanos cómo te fue con {negocio}: {link}',
    // Horario de atención: si enabled, solo se confirman pedidos dentro del horario
    // (los programados no se bloquean). Rango(s) "HH:MM-HH:MM" por día ('' = cerrado).
    hours: (() => {
      const h = (c.hours && typeof c.hours === 'object') ? c.hours : {}
      const d = (h.days && typeof h.days === 'object') ? h.days : {}
      return { enabled: !!h.enabled, days: { mon: d.mon || '', tue: d.tue || '', wed: d.wed || '', thu: d.thu || '', fri: d.fri || '', sat: d.sat || '', sun: d.sun || '' } }
    })(),
  }
}

// ── Horario de atención ─────────────────────────────────────────────────────────
function nowInTz(tz) {
  const d = new Date()
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Bogota', weekday: 'short' }).format(d).toLowerCase().slice(0, 3)
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return { day, hhmm }
}
function isOpenNow(hours, tz) {
  if (!hours?.enabled) return { open: true }
  try {
    const { day, hhmm } = nowInTz(tz)
    const ranges = String(hours.days?.[day] || '').split(',').map(s => s.trim()).filter(Boolean)
    for (const r of ranges) {
      const [o, c] = r.split('-').map(s => s.trim())
      if (!o || !c) continue
      if (c > o) { if (hhmm >= o && hhmm <= c) return { open: true } }
      else if (hhmm >= o || hhmm <= c) return { open: true }   // cruza medianoche (20:00-02:00)
    }
    return { open: false, todayHours: hours.days?.[day] || '' }
  } catch { return { open: true } }
}

// Config pública para el runtime/UI (va dentro de account.orders).
async function publicConfigAsync(accId) {
  const c = normConfig(await loadConfig(accId))
  const menu = await hasMenu(accId)
  return { ...c, connected: !!(c.enabled && menu), hasMenu: menu }
}
// Versión síncrona (para el payload de la cuenta que ya trae la config parseada).
function publicConfig(cfg) {
  const c = normConfig(cfg)
  return { ...c, connected: !!c.enabled }  // el gating fino de menú se valida en runtime
}

// ── Utilidades ─────────────────────────────────────────────────────────────────
function fmtMoney(n, currency) {
  const v = Number(n) || 0
  try { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: currency || 'COP', maximumFractionDigits: 0 }).format(v) }
  catch { return `${Math.round(v).toLocaleString('es-CO')} ${currency || ''}`.trim() }
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
const isDate = s => /^\d{4}-\d{2}-\d{2}/.test(String(s || '').trim())

// Identidad del cliente desde la conversación.
async function guestIdentity(accId, convId) {
  if (!convId) return { name: '', phone: '' }
  try {
    const [[c]] = await pool.query('SELECT guest_name, wa_from, local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!c) return { name: '', phone: '' }
    const lv = parseJ(c.local_vars, {})
    let phone = c.wa_from || ''
    if (!phone) for (const [k, v] of Object.entries(lv)) { if (/tel|phone|cel|whats/i.test(k) && String(v).replace(/\D/g, '').length >= 7) { phone = String(v).trim(); break } }
    const name = (c.guest_name && !/^(Visitante|Guest|WA #|FB #|IG #)/i.test(c.guest_name)) ? c.guest_name : (lv.nombre || lv.name || c.guest_name || '')
    return { name: String(name || '').trim(), phone: String(phone || '').trim() }
  } catch { return { name: '', phone: '' } }
}

// ── Menú / catálogo (lectura) ──────────────────────────────────────────────────
const mapProduct = p => {
  const price = Number(p.price) || 0
  const promo = Number(p.promo_price) || 0
  const onSale = promo > 0 && promo < price
  const comboItems = parseJ(p.combo_items, []).filter(c => c && c.name)
  return {
    id: p.id, category: p.category || '', name: p.name, description: p.description || '',
    price, promoPrice: onSale ? promo : 0, effPrice: onSale ? promo : price, onSale,
    comboItems, isCombo: comboItems.length > 0,
    mediaId: p.media_id || null, imageUrl: p.image_url || '',
    modifierGroupIds: parseJ(p.modifier_group_ids, []), available: !!p.available, sort: p.sort || 0,
    source: p.source || 'menu', sourceRef: p.source_ref || '',
  }
}
async function listProducts(accId, { onlyAvailable = false } = {}) {
  const [rows] = await pool.query('SELECT * FROM order_products WHERE account_id=? ORDER BY category, sort, name', [accId])
  const list = rows.map(mapProduct)
  return onlyAvailable ? list.filter(p => p.available) : list
}
const mapGroup = g => ({ id: g.id, name: g.name, minSelect: g.min_select || 0, maxSelect: g.max_select ?? 1, required: !!g.required, sort: g.sort || 0 })
async function listGroups(accId) {
  const [gs] = await pool.query('SELECT * FROM order_modifier_groups WHERE account_id=? ORDER BY sort, name', [accId])
  const [ms] = await pool.query('SELECT * FROM order_modifiers WHERE account_id=? ORDER BY sort, name', [accId])
  return gs.map(g => ({ ...mapGroup(g), modifiers: ms.filter(m => m.group_id === g.id).map(m => ({ id: m.id, name: m.name, priceDelta: Number(m.price_delta) || 0, available: !!m.available })) }))
}
const mapZone = z => ({ id: z.id, name: z.name, fee: Number(z.fee) || 0, minOrder: Number(z.min_order) || 0, etaMin: z.eta_min || 0, sort: z.sort || 0 })
async function listZones(accId) {
  const [rows] = await pool.query('SELECT * FROM order_zones WHERE account_id=? ORDER BY sort, name', [accId])
  return rows.map(mapZone)
}
const mapCourier = c => ({ id: c.id, name: c.name, phone: c.phone || '', active: !!c.active })
async function listCouriers(accId) {
  const [rows] = await pool.query('SELECT * FROM order_couriers WHERE account_id=? ORDER BY name', [accId])
  return rows.map(mapCourier)
}

// ── Carrito = pedido borrador por conversación ─────────────────────────────────
const mapOrder = o => ({
  id: o.id, code: o.code, type: o.type, status: o.status,
  items: parseJ(o.items, []), subtotal: Number(o.subtotal) || 0, deliveryFee: Number(o.delivery_fee) || 0,
  tax: Number(o.tax) || 0, tip: Number(o.tip) || 0, packagingFee: Number(o.packaging_fee) || 0,
  discount: Number(o.discount) || 0, total: Number(o.total) || 0, currency: o.currency || 'COP',
  couponCode: o.coupon_code || '',
  address: parseJ(o.address, null), zoneId: o.zone_id || null, tableLabel: o.table_label || '',
  scheduledFor: o.scheduled_for || '', courierId: o.courier_id || null,
  paymentMethod: o.payment_method || '', paymentStatus: o.payment_status || 'pending', cashAmount: o.cash_amount != null ? Number(o.cash_amount) : null,
  notes: o.notes || '', timeline: parseJ(o.timeline, []), convId: o.conv_id, contactId: o.contact_id,
  customerName: o.customer_name || '', customerPhone: o.customer_phone || '',
  createdAt: o.created_at, updatedAt: o.updated_at,
})
async function getDraft(accId, convId, { create = false } = {}) {
  if (!convId) return null
  const [[o]] = await pool.query("SELECT * FROM orders WHERE account_id=? AND conv_id=? AND status='draft' ORDER BY created_at DESC LIMIT 1", [accId, convId])
  if (o) return mapOrder(o)
  if (!create) return null
  const id = 'ord_' + uid(); const now = Date.now()
  await pool.query('INSERT INTO orders (id,account_id,conv_id,type,status,items,timeline,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, accId, convId, 'delivery', 'draft', '[]', '[]', now, now])
  const [[n]] = await pool.query('SELECT * FROM orders WHERE id=?', [id])
  return mapOrder(n)
}
async function saveDraft(accId, draft) {
  await pool.query(
    'UPDATE orders SET type=?, items=?, address=?, zone_id=?, table_label=?, scheduled_for=?, notes=?, updated_at=? WHERE id=? AND account_id=?',
    [draft.type, JSON.stringify(draft.items || []), draft.address ? JSON.stringify(draft.address) : null, draft.zoneId || null, draft.tableLabel || '', draft.scheduledFor || '', draft.notes || '', Date.now(), draft.id, accId]
  )
}

function cartTotals(draft, cfg, zone, coupon) {
  const c = normConfig(cfg)
  const subtotal = (draft.items || []).reduce((s, it) => s + (Number(it.lineTotal) || 0), 0)
  let deliveryFee = 0
  if (draft.type === 'delivery') {
    deliveryFee = zone ? Number(zone.fee) || 0 : 0
    if (c.freeDeliveryThreshold && subtotal >= c.freeDeliveryThreshold) deliveryFee = 0
  }
  const packaging = c.packagingFee || 0
  const tax = c.taxPct ? Math.round(subtotal * c.taxPct) / 100 : 0
  const tip = Number(draft.tip) || 0
  const discount = couponDiscount(coupon, subtotal)
  const total = Math.max(0, subtotal + deliveryFee + packaging + tax + tip - discount)
  return { subtotal, deliveryFee, packaging, tax, tip, discount, total, currency: c.currency }
}

// ── Cupones de descuento ────────────────────────────────────────────────────────
const mapCoupon = c => ({ id: c.id, code: c.code, type: c.type || 'percent', value: Number(c.value) || 0, minOrder: Number(c.min_order) || 0, maxDiscount: Number(c.max_discount) || 0, usesMax: c.uses_max || 0, usesCount: c.uses_count || 0, active: !!c.active, expiresAt: c.expires_at || null })
async function listCoupons(accId) {
  const [rows] = await pool.query('SELECT * FROM order_coupons WHERE account_id=? ORDER BY created_at DESC', [accId])
  return rows.map(mapCoupon)
}
async function getCoupon(accId, code) {
  if (!code) return null
  const [[c]] = await pool.query('SELECT * FROM order_coupons WHERE account_id=? AND UPPER(code)=? LIMIT 1', [accId, String(code).toUpperCase()])
  return c ? mapCoupon(c) : null
}
function couponDiscount(coupon, subtotal) {
  if (!coupon || !coupon.active) return 0
  let d = coupon.type === 'fixed' ? coupon.value : (subtotal * coupon.value / 100)
  if (coupon.maxDiscount) d = Math.min(d, coupon.maxDiscount)
  return Math.round(Math.max(0, Math.min(d, subtotal)))
}
// Devuelve null si el cupón es válido, o el motivo de rechazo.
function couponError(coupon, subtotal, currency) {
  if (!coupon) return 'ese cupón no existe'
  if (!coupon.active) return 'ese cupón está inactivo'
  if (coupon.expiresAt && Date.now() > Number(coupon.expiresAt)) return 'ese cupón está vencido'
  if (coupon.usesMax && coupon.usesCount >= coupon.usesMax) return 'ese cupón alcanzó su límite de usos'
  if (coupon.minOrder && subtotal < coupon.minOrder) return `requiere un pedido mínimo de ${fmtMoney(coupon.minOrder, currency)}`
  return null
}

// ── Resolución de producto / adiciones (para agregar al carrito) ────────────────
function findProduct(products, query) {
  const q = norm(query)
  if (!q) return null
  return products.find(p => norm(p.name) === q) ||
    products.find(p => norm(p.name).includes(q) || q.includes(norm(p.name))) ||
    products.find(p => norm(p.name).split(/\s+/).some(w => w.length > 3 && q.includes(w))) || null
}

// ── Notas internas + CRM (reuso del patrón de pms.js) ──────────────────────────
async function internalNote(accId, agId, convId, content) {
  try {
    if (!convId) return
    const [[c]] = await pool.query('SELECT id FROM conversations WHERE id=? AND account_id=? LIMIT 1', [convId, accId])
    if (!c) return
    await pool.query('INSERT INTO crm_notes (id,account_id,target_type,target_id,author_id,author_name,content,ts) VALUES (?,?,?,?,?,?,?,?)',
      ['note_' + uid(), accId, 'conversation', convId, 'orders', 'Asistente Pedidos', String(content || '').slice(0, 600), Date.now()])
    await pool.query('UPDATE conversations SET unread=1, unread_count=unread_count+1 WHERE id=? AND account_id=?', [convId, accId])
    socket.emit(accId, 'convos:updated', { accId, agId })
  } catch {}
}
async function upsertCrmContact(accId, { name, phone }, note) {
  try {
    if (!phone) return null
    const [[found]] = await pool.query('SELECT id, extra FROM contacts WHERE account_id=? AND phone<>"" AND phone=? LIMIT 1', [accId, phone])
    if (found) {
      const extra = parseJ(found.extra, {}); const tags = Array.isArray(extra.tags) ? extra.tags : []
      if (!tags.includes('pedidos')) tags.push('pedidos'); extra.tags = tags; extra.lastOrder = note || extra.lastOrder
      await pool.query('UPDATE contacts SET extra=? WHERE id=?', [JSON.stringify(extra), found.id]); return found.id
    }
    const id = 'ct_' + uid()
    await pool.query('INSERT INTO contacts (id,account_id,name,email,phone,extra,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, accId, name || 'Cliente', '', phone, JSON.stringify({ tags: ['pedidos'], source: 'orders', lastOrder: note || '' }), Date.now()])
    return id
  } catch { return null }
}

function shortCode() { return 'P-' + Math.random().toString(36).slice(2, 7).toUpperCase() }
// Link público de seguimiento del pedido (página /track/:accId/:code).
function trackUrl(accId, code) {
  const base = (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
  return `${base}/track/${accId}/${code}`
}

// ── Despachador de funciones del asistente ─────────────────────────────────────
async function toolCall(accId, fn, args = {}, { convId, agId } = {}) {
  const cfg = normConfig(await loadConfig(accId))
  if (!cfg.enabled) return { text: 'El módulo de pedidos no está activo. El equipo debe configurarlo en Zona IA → Pedidos.' }
  const currency = cfg.currency

  // ── Ver menú (con fotos opcionales) ───────────────────────────────────────
  if (fn === 'ver_menu') {
    const products = await listProducts(accId, { onlyAvailable: true })
    if (!products.length) return { text: 'El menú aún no tiene productos publicados.' }
    const cat = norm(args.categoria || '')
    const filtered = cat ? products.filter(p => norm(p.category).includes(cat) || cat.includes(norm(p.category))) : products
    if (!filtered.length) return { text: `No hay productos en esa categoría. Categorías: ${[...new Set(products.map(p => p.category).filter(Boolean))].join(', ')}.` }
    // Agrupa por categoría.
    const byCat = {}
    for (const p of filtered) { (byCat[p.category || 'Menú'] ||= []).push(p) }
    const lines = Object.entries(byCat).map(([c, items]) =>
      `▪ ${c}\n` + items.map(p => {
        const priceTxt = p.onSale ? `🔥 ${fmtMoney(p.effPrice, currency)} (antes ${fmtMoney(p.price, currency)})` : fmtMoney(p.effPrice, currency)
        const comboTxt = p.isCombo ? ` — incluye: ${p.comboItems.map(ci => `${ci.qty > 1 ? `${ci.qty}× ` : ''}${ci.name}`).join(', ')}` : ''
        return `   • ${p.isCombo ? '🍱 ' : ''}${p.name} — ${priceTxt}${p.description ? ` (${String(p.description).slice(0, 80)})` : ''}${comboTxt}`
      }).join('\n')
    ).join('\n')
    // Envía hasta 6 fotos si se pidió una categoría concreta.
    const media = (cat ? filtered : []).slice(0, 6).filter(p => p.imageUrl || p.mediaId).map(p => ({
      url: p.imageUrl || `/api/media/${accId}/${p.mediaId}/raw`, caption: `${p.name} · ${fmtMoney(p.effPrice, currency)}${p.onSale ? ' 🔥oferta' : ''}`, needsHost: !p.imageUrl,
    }))
    return { text: `Menú disponible:\n${lines}\n\nPara agregar algo usa agregar_al_pedido con el nombre y la cantidad.`, media }
  }

  // ── Agregar al pedido ─────────────────────────────────────────────────────
  if (fn === 'agregar_al_pedido') {
    const products = await listProducts(accId, { onlyAvailable: true })
    const prod = findProduct(products, args.producto)
    if (!prod) return { text: `No encontré "${args.producto}" en el menú. Productos: ${products.map(p => p.name).slice(0, 20).join(', ')}.` }
    const qty = Math.max(1, Number(args.cantidad) || 1)
    // Resolver adiciones/modificadores solicitados contra los grupos del producto.
    let modifiers = [], modTotal = 0
    if (prod.modifierGroupIds.length && (args.adiciones || args.modificadores)) {
      const groups = (await listGroups(accId)).filter(g => prod.modifierGroupIds.includes(g.id))
      const wanted = String(args.adiciones || args.modificadores || '').split(/[,;]+/).map(norm).filter(Boolean)
      for (const g of groups) for (const m of g.modifiers) {
        if (!m.available) continue
        if (wanted.some(w => norm(m.name).includes(w) || w.includes(norm(m.name)))) { modifiers.push({ groupId: g.id, id: m.id, name: m.name, priceDelta: m.priceDelta }); modTotal += m.priceDelta }
      }
    }
    const unitPrice = (prod.effPrice || prod.price) + modTotal
    const lineTotal = unitPrice * qty
    const draft = await getDraft(accId, convId, { create: true })
    if (!draft) return { text: 'No pude iniciar el pedido (conversación no válida).' }
    draft.items = draft.items || []
    const combo = prod.isCombo ? prod.comboItems.map(ci => ({ name: ci.name, qty: Number(ci.qty) || 1 })) : []
    draft.items.push({ productId: prod.id, name: prod.name, qty, unitPrice, modifiers, combo, isCombo: prod.isCombo, note: String(args.nota || '').slice(0, 140), lineTotal })
    await saveDraft(accId, draft)
    const t = cartTotals(draft, cfg)
    const modTxt = modifiers.length ? ` (${modifiers.map(m => m.name).join(', ')})` : ''
    const comboTxt = combo.length ? ` — incluye ${combo.map(c => `${c.qty > 1 ? `${c.qty}× ` : ''}${c.name}`).join(', ')}` : ''
    return { text: `Agregué ${qty}× ${prod.isCombo ? '🍱 ' : ''}${prod.name}${modTxt}${comboTxt}. Subtotal del pedido: ${fmtMoney(t.subtotal, currency)}. ¿Algo más o cerramos el pedido?` }
  }

  // ── Ver carrito ───────────────────────────────────────────────────────────
  if (fn === 'ver_carrito' || fn === 'ver_pedido') {
    const draft = await getDraft(accId, convId)
    if (!draft || !draft.items.length) return { text: 'El pedido está vacío. Agrega productos con agregar_al_pedido.' }
    const coupon = draft.couponCode ? await getCoupon(accId, draft.couponCode) : null
    const t = cartTotals(draft, cfg, null, coupon)
    const lines = draft.items.map((it, i) => `${i + 1}. ${it.qty}× ${it.name}${it.modifiers?.length ? ` (${it.modifiers.map(m => m.name).join(', ')})` : ''} — ${fmtMoney(it.lineTotal, currency)}`).join('\n')
    return { text: `Pedido actual:\n${lines}\n\nSubtotal: ${fmtMoney(t.subtotal, currency)}${t.discount ? `\nDescuento (${draft.couponCode}): -${fmtMoney(t.discount, currency)}` : ''}${draft.type === 'delivery' && t.deliveryFee ? `\nEnvío: ${fmtMoney(t.deliveryFee, currency)}` : ''}${t.packaging ? `\nEmpaque: ${fmtMoney(t.packaging, currency)}` : ''}${t.tax ? `\nImpuesto: ${fmtMoney(t.tax, currency)}` : ''}\nTOTAL: ${fmtMoney(t.total, currency)}` }
  }

  // ── Aplicar cupón de descuento ────────────────────────────────────────────
  if (fn === 'aplicar_cupon') {
    const draft = await getDraft(accId, convId)
    if (!draft || !draft.items.length) return { text: 'Primero agrega productos al pedido y luego aplica el cupón.' }
    const code = String(args.codigo || '').trim()
    if (!code) return { text: 'Pídele al cliente el código del cupón.' }
    const coupon = await getCoupon(accId, code)
    const t0 = cartTotals(draft, cfg)
    const err = couponError(coupon, t0.subtotal, currency)
    if (err) return { text: `No pude aplicar el cupón "${code}": ${err}.` }
    await pool.query('UPDATE orders SET coupon_code=? WHERE id=? AND account_id=?', [coupon.code, draft.id, accId])
    const t = cartTotals(draft, cfg, null, coupon)
    return { text: `🎟 Cupón "${coupon.code}" aplicado: descuento de ${fmtMoney(t.discount, currency)}. Subtotal con descuento: ${fmtMoney(t.subtotal - t.discount, currency)} (el envío, si es domicilio, se suma al confirmar). Continúa con los datos de entrega y confirma.` }
  }

  // ── Quitar del pedido ─────────────────────────────────────────────────────
  if (fn === 'quitar_del_pedido') {
    const draft = await getDraft(accId, convId)
    if (!draft || !draft.items.length) return { text: 'El pedido está vacío.' }
    const idx = Number(args.indice) - 1
    if (!isNaN(idx) && draft.items[idx]) { const rm = draft.items.splice(idx, 1)[0]; await saveDraft(accId, draft); return { text: `Quité ${rm.name} del pedido.` } }
    const q = norm(args.producto || '')
    const i = draft.items.findIndex(it => norm(it.name).includes(q))
    if (i >= 0) { const rm = draft.items.splice(i, 1)[0]; await saveDraft(accId, draft); return { text: `Quité ${rm.name} del pedido.` } }
    return { text: 'No encontré ese producto en el pedido. Usa ver_carrito para ver los números.' }
  }

  // ── Fijar datos de entrega ────────────────────────────────────────────────
  if (fn === 'fijar_datos_entrega') {
    const draft = await getDraft(accId, convId, { create: true })
    if (!draft) return { text: 'No pude iniciar el pedido.' }
    const tipo = String(args.tipo || '').toLowerCase()
    const map = { domicilio: 'delivery', delivery: 'delivery', recoger: 'pickup', pickup: 'pickup', llevar: 'pickup', local: 'dinein', mesa: 'dinein', dinein: 'dinein', programado: 'scheduled', scheduled: 'scheduled' }
    if (tipo && map[tipo]) {
      if (!cfg.orderTypes.includes(map[tipo])) return { text: `El negocio no ofrece pedidos ${TYPE_LABEL[map[tipo]] || tipo}. Disponibles: ${cfg.orderTypes.map(t => TYPE_LABEL[t]).join(', ')}.` }
      draft.type = map[tipo]
    }
    if (draft.type === 'delivery' && args.direccion) draft.address = { text: String(args.direccion).slice(0, 300), references: String(args.referencias || '').slice(0, 200), geo: args.ubicacion || '' }
    if (draft.type === 'dinein' && args.mesa) draft.tableLabel = String(args.mesa).slice(0, 40)
    if (draft.type === 'scheduled' && args.para) draft.scheduledFor = String(args.para).slice(0, 40)
    // Resolver zona si es domicilio.
    let zoneMsg = ''
    if (draft.type === 'delivery') {
      const zones = await listZones(accId)
      if (zones.length) {
        const zq = norm(args.zona || args.direccion || '')
        const zone = zones.find(z => zq && (norm(z.name).includes(norm(args.zona || '')) || (args.zona && norm(args.zona).includes(norm(z.name))))) ||
          (args.zona ? null : null)
        if (zone) { draft.zoneId = zone.id; zoneMsg = ` Envío a ${zone.name}: ${fmtMoney(zone.fee, currency)}${zone.etaMin ? ` (~${zone.etaMin} min)` : ''}.` }
        else if (args.zona) zoneMsg = ` No reconocí la zona "${args.zona}". Zonas: ${zones.map(z => z.name).join(', ')}.`
        else zoneMsg = ` Indica la zona de entrega para calcular el envío. Zonas: ${zones.map(z => z.name).join(', ')}.`
      }
    }
    await saveDraft(accId, draft)
    return { text: `Pedido ${TYPE_LABEL[draft.type] || draft.type}${draft.address?.text ? ` a: ${draft.address.text}` : ''}${draft.tableLabel ? ` (mesa ${draft.tableLabel})` : ''}${draft.scheduledFor ? ` para ${draft.scheduledFor}` : ''}.${zoneMsg}` }
  }

  // ── Confirmar pedido ──────────────────────────────────────────────────────
  if (fn === 'confirmar_pedido') {
    const draft = await getDraft(accId, convId)
    if (!draft || !draft.items.length) return { text: 'El pedido está vacío. Agrega productos antes de confirmar.' }
    // Horario de atención: no se confirman pedidos fuera del horario (salvo programados).
    if (cfg.hours?.enabled && draft.type !== 'scheduled') {
      try {
        const [[acc]] = await pool.query('SELECT ai_timezone FROM accounts WHERE id=?', [accId])
        const st = isOpenNow(cfg.hours, acc?.ai_timezone)
        if (!st.open) return { text: `El negocio está CERRADO ahora mismo${st.todayHours ? ` (horario de hoy: ${st.todayHours})` : ' (hoy no abrimos)'}. No se puede confirmar el pedido en este momento. Ofrécele al cliente dejarlo PROGRAMADO para más tarde (tipo "programado") o volver dentro del horario de atención.` }
      } catch {}
    }
    const zones = draft.type === 'delivery' ? await listZones(accId) : []
    const zone = zones.find(z => z.id === draft.zoneId) || null
    if (draft.type === 'delivery' && zones.length && !zone) return { text: 'Falta la zona de entrega para calcular el envío. Pídele al cliente su zona/dirección y usa fijar_datos_entrega.' }
    if (draft.type === 'delivery' && !draft.address?.text) return { text: 'Falta la dirección de entrega. Pídesela al cliente y usa fijar_datos_entrega.' }
    if (args.propina != null) draft.tip = Math.max(0, Number(args.propina) || 0)
    // Cupón: el pasado en args (nuevo) o el ya aplicado al carrito.
    let coupon = null
    const couponCode = String(args.cupon || draft.couponCode || '').trim()
    if (couponCode) {
      coupon = await getCoupon(accId, couponCode)
      const cErr = coupon ? couponError(coupon, cartTotals(draft, cfg, zone).subtotal, currency) : 'ese cupón no existe'
      if (cErr) return { text: `No se puede confirmar: el cupón "${couponCode}" no es válido (${cErr}). Quítalo o pide otro.` }
    }
    const t = cartTotals(draft, cfg, zone, coupon)
    // Mínimo de pedido (global o de la zona).
    const minOrder = Math.max(cfg.minOrder || 0, zone?.minOrder || 0)
    if (minOrder && t.subtotal < minOrder) return { text: `El pedido mínimo${zone ? ` para ${zone.name}` : ''} es ${fmtMoney(minOrder, currency)} y el subtotal es ${fmtMoney(t.subtotal, currency)}. Invita al cliente a agregar algo más.` }

    // Identidad del cliente.
    const ident = await guestIdentity(accId, convId)
    const name = String(args.nombre || ident.name || '').trim()
    const phone = String(args.telefono || ident.phone || '').trim()

    const method = String(args.metodo_pago || '').toLowerCase()
    const wantsOnline = /linea|online|tarjeta|link|wompi/.test(method) && cfg.paymentMethods.includes('online')
    const isCash = /efectivo|contra|cash|entrega/.test(method) || (!wantsOnline && cfg.paymentMethods.includes('cash'))
    const paymentMethod = wantsOnline ? 'online' : (isCash ? 'cash' : (cfg.paymentMethods[0] || 'cash'))
    const cashAmount = paymentMethod === 'cash' && args.paga_con ? Math.max(0, Number(String(args.paga_con).replace(/[^\d.]/g, '')) || 0) : null

    // Contacto CRM.
    const contactId = await upsertCrmContact(accId, { name, phone }, `Pedido ${TYPE_LABEL[draft.type]}`).catch(() => null)

    // Persistir el pedido (draft → received).
    const code = shortCode()
    const timeline = [{ status: 'received', at: Date.now(), by: 'ia' }]
    await pool.query(
      `UPDATE orders SET code=?, status='received', contact_id=?, customer_name=?, customer_phone=?, subtotal=?, delivery_fee=?, tax=?, tip=?, packaging_fee=?, discount=?, coupon_code=?, total=?, currency=?,
        payment_method=?, payment_status=?, cash_amount=?, notes=?, timeline=?, updated_at=? WHERE id=? AND account_id=?`,
      [code, contactId, name || null, phone || null, t.subtotal, t.deliveryFee, t.tax, t.tip, t.packaging, t.discount || 0, coupon ? coupon.code : null, t.total, currency,
       paymentMethod, 'pending', cashAmount, String(args.nota || draft.notes || '').slice(0, 300), JSON.stringify(timeline), Date.now(), draft.id, accId]
    )
    // Suma un uso al cupón (best-effort).
    if (coupon) pool.query('UPDATE order_coupons SET uses_count=uses_count+1 WHERE id=? AND account_id=?', [coupon.id, accId]).catch(() => {})
    socket.emit(accId, 'orders:updated', { accId })

    // Pago en línea (link Wompi) si aplica. Guarda la referencia para que el webhook
    // confirme el pedido automáticamente al aprobarse el pago.
    let paymentUrl = ''
    if (paymentMethod === 'online') {
      try {
        const payments = require('./payments')
        const r = await payments.createPaymentLink(accId, { amount: t.total, description: `Pedido ${code}`, currency, convId, agId })
        paymentUrl = r?.url || ''
        if (r?.reference) await pool.query('UPDATE orders SET payment_ref=? WHERE id=? AND account_id=?', [r.reference, draft.id, accId]).catch(() => {})
      } catch (e) { /* si falla el link, se entrega igual y se cobra contra entrega */ }
    }

    if (cfg.notifyTeam) internalNote(accId, agId, convId, `🛵 PEDIDO NUEVO ${code} (${TYPE_LABEL[draft.type]}) — ${draft.items.map(it => `${it.qty}× ${it.name}`).join(', ')} · Total ${fmtMoney(t.total, currency)} · ${paymentMethod === 'online' ? 'Pago en línea' : `Contra entrega${cashAmount ? ` (paga con ${fmtMoney(cashAmount, currency)})` : ''}`}${draft.address?.text ? ` · ${draft.address.text}` : ''} · Cliente: ${name || '—'} ${phone}`).catch(() => {})

    // Flujo post-pedido opcional.
    if (cfg.postOrderFlowId) {
      try { require('../flow/engine').executeFlow({ flowId: cfg.postOrderFlowId, accId, agId, convId, triggerContext: { orderCode: code } }).catch(() => {}) } catch {}
    }

    const changeTxt = cashAmount && cashAmount > t.total ? ` Vuelto: ${fmtMoney(cashAmount - t.total, currency)}.` : ''
    const track = trackUrl(accId, code)
    return {
      text: `✅ Pedido CONFIRMADO — código ${code}.\n${draft.items.map(it => `• ${it.qty}× ${it.name}`).join('\n')}\n${t.discount ? `Descuento (${coupon.code}): -${fmtMoney(t.discount, currency)}\n` : ''}${draft.type === 'delivery' && t.deliveryFee ? `Envío: ${fmtMoney(t.deliveryFee, currency)}\n` : ''}TOTAL: ${fmtMoney(t.total, currency)}\nPago: ${paymentMethod === 'online' ? 'en línea' : 'contra entrega'}.${changeTxt}${paymentUrl ? `\nLink de pago: ${paymentUrl}` : ''}\nSeguimiento en vivo: ${track}\nConfírmale al cliente el código ${code}${paymentUrl ? ', envíale el link de pago' : ''} y el link de seguimiento.`,
      ordered: true, orderCode: code, paymentUrl, trackUrl: track,
    }
  }

  // ── Estado / seguimiento ──────────────────────────────────────────────────
  if (fn === 'estado_pedido') {
    const code = String(args.codigo || '').trim().toUpperCase()
    if (!code) return { text: 'Necesito el código del pedido (ej. P-AB12C).' }
    const [[o]] = await pool.query('SELECT * FROM orders WHERE account_id=? AND UPPER(code)=? LIMIT 1', [accId, code])
    if (!o) return { text: `No encontré un pedido con el código ${code}. Verifícalo con el cliente.` }
    const ord = mapOrder(o)
    const label = { received: 'recibido', confirmed: 'confirmado', preparing: 'en preparación', ready: 'listo', on_the_way: 'en camino', delivered: 'entregado', canceled: 'cancelado' }[ord.status] || ord.status
    return { text: `Pedido ${code}: ${label}. ${ord.items.map(it => `${it.qty}× ${it.name}`).join(', ')} · Total ${fmtMoney(ord.total, currency)}.\nSeguimiento en vivo: ${trackUrl(accId, code)}` }
  }

  return { text: `Función de pedidos desconocida: ${fn}` }
}

// ── Aviso al cliente cuando cambia el estado del pedido ─────────────────────────
// Envía un mensaje por el canal de la conversación (WhatsApp/Messenger/IG por API,
// webchat/otros por socket). No crítico: cualquier fallo se ignora.
async function notifyCustomerStatus(accId, order, status) {
  try {
    const cfg = normConfig(await loadConfig(accId))
    if (cfg.notifyCustomer === false) return
    if (!order?.conv_id) return
    const tmpl = (cfg.statusMessages && cfg.statusMessages[status]) || STATUS_MSG_DEFAULT[status]
    if (!tmpl || !String(tmpl).trim()) return   // estado sin plantilla → no se avisa

    const [[conv]] = await pool.query('SELECT * FROM conversations WHERE id=? AND account_id=? LIMIT 1', [order.conv_id, accId])
    if (!conv) return
    const agId = conv.agent_id
    const [[ag]] = await pool.query('SELECT * FROM agents WHERE id=? AND account_id=? LIMIT 1', [agId, accId])
    const agent = ag ? { id: ag.id, channels: parseJ(ag.channels, []), whatsapp: parseJ(ag.whatsapp, null) } : null

    const text = String(tmpl)
      .replace(/\{code\}/g, order.code || '')
      .replace(/\{estado\}/g, STATUS_LABEL[status] || status)
      .replace(/\{negocio\}/g, cfg.businessName || '')
      .replace(/\{tipo\}/g, TYPE_LABEL[order.type] || '')
      .replace(/\{total\}/g, fmtMoney(order.total, cfg.currency))

    const isExternal = EXTERNAL_CHANNELS.has(conv.channel_type)
    const to = conv.wa_from || conv.messenger_from || conv.ig_from
    const outbound = (isExternal && agent) ? buildOutbound(agent, conv.channel_type, conv.channel_id, to) : null
    if (isExternal && !outbound) return   // canal externo sin credenciales/destino
    await sendBotMsg({ accId, agId, convId: conv.id, _outbound: outbound }, text, { orderNotify: true, orderCode: order.code })

    // Reseña automática al entregar: segundo mensaje con el enlace de reseña.
    if (status === 'delivered' && cfg.reviewEnabled && String(cfg.reviewUrl || '').trim() && String(cfg.reviewMessage || '').trim()) {
      const reviewText = String(cfg.reviewMessage)
        .replace(/\{negocio\}/g, cfg.businessName || '')
        .replace(/\{link\}/g, cfg.reviewUrl)
        .replace(/\{code\}/g, order.code || '')
      await sendBotMsg({ accId, agId, convId: conv.id, _outbound: outbound }, reviewText, { orderReview: true, orderCode: order.code }).catch(() => {})
    }
  } catch (e) { /* no crítico */ }
}

// ── Pago aprobado → marca el pedido pagado + lo confirma + avisa al cliente ──────
// Lo invoca el webhook de la pasarela con la `reference` del intento de pago.
async function markPaidByRef(accId, reference) {
  try {
    if (!reference) return
    const [[o]] = await pool.query('SELECT * FROM orders WHERE account_id=? AND payment_ref=? LIMIT 1', [accId, String(reference)])
    if (!o || o.payment_status === 'paid') return
    const wasReceived = o.status === 'received'
    const tl = parseJ(o.timeline, [])
    const sets = ['payment_status=?']; const vals = ['paid']
    if (wasReceived) { sets.push('status=?'); vals.push('confirmed'); tl.push({ status: 'confirmed', at: Date.now(), by: 'pago' }) }
    sets.push('timeline=?'); vals.push(JSON.stringify(tl))
    sets.push('updated_at=?'); vals.push(Date.now(), o.id, accId)
    await pool.query(`UPDATE orders SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'orders:updated', { accId })
    // Nota interna + aviso de confirmación al cliente (si el pago lo confirmó).
    internalNote(accId, o.agent_id, o.conv_id, `💳 PAGO CONFIRMADO del pedido ${o.code} — ${fmtMoney(o.total, o.currency)}.`).catch(() => {})
    if (wasReceived) await notifyCustomerStatus(accId, { conv_id: o.conv_id, code: o.code, total: o.total, currency: o.currency, type: o.type }, 'confirmed')
  } catch (e) { /* no crítico */ }
}

module.exports = {
  ORDER_TYPES, TYPE_LABEL, STATUSES,
  loadConfig, saveConfig, publicConfig, publicConfigAsync, normConfig,
  listProducts, listGroups, listZones, listCouriers, listCoupons, mapOrder,
  toolCall, notifyCustomerStatus, markPaidByRef,
}
