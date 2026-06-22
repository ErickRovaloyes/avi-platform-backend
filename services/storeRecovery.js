'use strict'
/**
 * Worker de recuperación de carritos / confirmación de pago para pedidos creados
 * por el asistente (WooCommerce + Shopify):
 *   1) Confirma el pago por SONDEO (imprescindible para Shopify; respaldo para Woo,
 *      que además tiene webhook instantáneo) → mensaje "✅ Pago confirmado".
 *   2) Recuperación de carrito: si el pedido sigue SIN pagar tras N horas
 *      (config. en la pestaña Tienda, por defecto 20h), envía un recordatorio por
 *      el canal de la conversación (WhatsApp si el chat es de WhatsApp) con el link
 *      de pago. Respeta un máximo de recordatorios.
 */
const pool = require('../db')
const store = require('./store')

const TICK_MS = 15 * 60 * 1000          // cada 15 min
const MAX_AGE_MS = 7 * 24 * 3600 * 1000  // no procesar pedidos de más de 7 días
const HOUR = 3600 * 1000

let _sendMsg = null
function sender() {
  // Carga diferida para evitar dependencia circular con el controlador.
  if (!_sendMsg) { try { _sendMsg = require('../controllers/woocommerce.controller').sendConversationMessage } catch { _sendMsg = async () => {} } }
  return _sendMsg
}

async function tick() {
  let rows = []
  try {
    const [r] = await pool.query('SELECT * FROM woo_orders WHERE paid_notified=0 AND created_at > ? ORDER BY created_at DESC LIMIT 200', [Date.now() - MAX_AGE_MS])
    rows = r
  } catch { return }
  const now = Date.now()
  const cfgCache = {}
  const send = sender()

  for (const rec of rows) {
    try {
      const accId = rec.account_id
      if (!(accId in cfgCache)) cfgCache[accId] = await store.loadConfig(accId)
      const cfg = cfgCache[accId]
      if (!store.isEnabled(cfg)) continue

      // 1) ¿Ya se pagó? (sondeo)
      const st = await store.getOrderStatus(accId, rec)
      if (st?.paid) {
        await pool.query('UPDATE woo_orders SET status=?, paid_notified=1, updated_at=? WHERE id=?', [st.status || 'paid', now, rec.id])
        const tot = (st.total || rec.total) ? ` por ${st.total || rec.total} ${st.currency || rec.currency || ''}`.trimEnd() : ''
        if (rec.conv_id) await send(accId, rec.agent_id, rec.conv_id, `✅ ¡Pago confirmado! Recibimos tu pago del pedido #${rec.order_id}${tot}. ¡Gracias por tu compra! 🎉`)
        continue
      }

      // 2) Recuperación de carrito (pedido sin pagar tras N horas)
      const ac = cfg.abandonedCart || {}
      if (!ac.enabled || !rec.conv_id || !rec.pay_url) continue
      const hours = Math.max(1, parseInt(ac.hours) || 20)
      const maxR = Math.max(1, parseInt(ac.maxReminders) || 1)
      const age = now - (rec.created_at || now)
      const sinceLast = now - (rec.last_reminder_at || 0)
      if (age >= hours * HOUR && (rec.reminders_sent || 0) < maxR && sinceLast >= hours * HOUR) {
        const base = (ac.message && ac.message.trim()) || '👋 ¿Terminamos tu compra? Dejaste un pedido sin completar. Puedes pagarlo aquí cuando quieras:'
        await send(accId, rec.agent_id, rec.conv_id, `${base}\n${rec.pay_url}`)
        await pool.query('UPDATE woo_orders SET reminders_sent=reminders_sent+1, last_reminder_at=? WHERE id=?', [now, rec.id])
      }
    } catch (e) { /* un pedido que falla no detiene el resto */ }
  }
}

function start() {
  setTimeout(() => { tick().catch(() => {}) }, 60 * 1000).unref?.()       // primer pase al minuto
  setInterval(() => { tick().catch(() => {}) }, TICK_MS).unref?.()
}

module.exports = { start, tick }
