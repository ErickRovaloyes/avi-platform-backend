'use strict'
/**
 * Recuperación de carritos abandonados de la PÁGINA WEB (distinto del carrito de
 * CHAT que gestiona storeRecovery.js):
 *   - Shopify: se leen nativamente los checkouts abandonados por API (pull).
 *   - WooCommerce: un plugin de carritos empuja los carritos al webhook
 *     /api/woocommerce/:accId/abandoned-cart (guardados en abandoned_carts).
 * Para contactar al cliente (teléfono del checkout) se usa WhatsApp:
 *   - Si hay una conversación con VENTANA de 24 h abierta → mensaje o flujo.
 *   - Si no (contacto en FRÍO) → plantilla de WhatsApp aprobada, con la URL de
 *     recuperación como variable del cuerpo.
 * Config en Zona IA → Tienda → Carrito abandonado → Web.
 */
const pool = require('../db')
const store = require('./store')
const flowStore = require('../flow/store')
const { sendBotMsg } = require('../flow/common')
const { buildOutbound } = require('./calendarNotify')
const { sendWhatsAppTemplate } = require('./metaSend')
const storeRecovery = require('./storeRecovery')

const TICK_MS = 15 * 60 * 1000
const HOUR = 3600 * 1000
const WINDOW_MS = 24 * HOUR
const MAX_AGE_MS = 7 * 24 * HOUR
const normPhone = p => String(p || '').replace(/[^\d]/g, '')

// Agente de la cuenta con un canal de WhatsApp conectado (para enviar) + su config.
function pickWaAgent(account) {
  for (const a of (account?.agents || [])) {
    const wa = (a.channels || []).find(c => c.type === 'whatsapp' && c.status === 'connected') || (a.channels || []).find(c => c.type === 'whatsapp')
    if (wa && wa.config?.phoneNumberId && wa.config?.accessToken) return { agent: a, channel: wa }
  }
  return null
}

// ¿Hay ventana de 24 h abierta? (último mensaje del cliente hace < 24 h).
async function windowOpen(convId) {
  try {
    const [[m]] = await pool.query("SELECT MAX(ts) AS t FROM messages WHERE conversation_id=? AND sender='user'", [convId])
    return !!(m?.t && (Date.now() - Number(m.t) < WINDOW_MS))
  } catch { return false }
}

// Guarda/actualiza un carrito web (dedup por id compuesto).
async function upsertCart(accId, platform, extId, { phone, email, recoveryUrl, total, currency, createdAt }) {
  const id = `${accId}:${platform}:${extId}`
  const now = Date.now()
  await pool.query(
    `INSERT INTO abandoned_carts (id, account_id, platform, external_id, phone, email, recovery_url, total, currency, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE phone=VALUES(phone), recovery_url=VALUES(recovery_url), total=VALUES(total), currency=VALUES(currency), updated_at=VALUES(updated_at)`,
    [id, accId, platform, extId, phone || null, email || null, recoveryUrl || '', String(total || ''), String(currency || ''), createdAt || now, now]
  ).catch(() => {})
}

// Pull de checkouts abandonados de Shopify → abandoned_carts.
async function pullShopify(accId, cfg) {
  if (store.platformOf(cfg) !== 'shopify') return
  const list = await store.fetchAbandonedCheckouts(accId).catch(() => [])
  for (const c of (list || [])) {
    const phone = normPhone(c.phone)
    if (!phone) continue
    await upsertCart(accId, 'shopify', String(c.id), { phone, recoveryUrl: c.recoveryUrl, total: c.total, currency: c.currency, createdAt: c.createdAt })
  }
}

// Procesa los carritos pendientes de una cuenta (envía recordatorio / plantilla).
async function processAccount(accId, cfg, ac) {
  const account = await flowStore.loadAccount(accId).catch(() => null)
  const wa = pickWaAgent(account)
  if (!wa) return                       // sin canal de WhatsApp no hay cómo contactar
  const web = ac.web
  const now = Date.now()
  const [rows] = await pool.query('SELECT * FROM abandoned_carts WHERE account_id=? AND recovered=0 AND created_at > ? ORDER BY created_at DESC LIMIT 200', [accId, now - MAX_AGE_MS])
  for (const cart of rows) {
    try {
      const phone = normPhone(cart.phone)
      if (!phone) continue
      const age = now - (cart.created_at || now)
      const sinceLast = now - (cart.last_reminder_at || 0)
      if (age < web.hours * HOUR || (cart.reminders_sent || 0) >= web.maxReminders || sinceLast < web.hours * HOUR) continue

      // ¿Existe ya una conversación de WhatsApp con este teléfono?
      const [[existing]] = await pool.query('SELECT id FROM conversations WHERE account_id=? AND wa_from=? LIMIT 1', [accId, phone])
      const url = cart.recovery_url || ''
      let sent = false

      if (existing && await windowOpen(existing.id)) {
        // Ventana abierta → mensaje libre o flujo.
        if (web.mode === 'flow' && web.flowId) {
          await storeRecovery.runRecoveryFlow(accId, wa.agent.id, existing.id, web.flowId, {
            source: 'abandoned_cart', tipo_carrito: 'web', pay_url: url, recovery_url: url,
            total: cart.total, currency: cart.currency, message: 'Recuperación de carrito web',
          })
        } else {
          const base = (web.message && web.message.trim()) || '👋 ¿Terminamos tu compra? Vi que dejaste productos en el carrito. Puedes completarla aquí:'
          const outbound = buildOutbound(wa.agent, 'whatsapp', wa.channel.id, phone)
          await sendBotMsg({ accId, agId: wa.agent.id, convId: existing.id, _outbound: outbound }, url ? `${base}\n${url}` : base)
        }
        await pool.query('UPDATE abandoned_carts SET conv_id=?, reminders_sent=reminders_sent+1, last_reminder_at=? WHERE id=?', [existing.id, now, cart.id])
        sent = true
      } else if (web.template?.name) {
        // Contacto en FRÍO → plantilla de WhatsApp (URL como variable del cuerpo).
        const components = url ? [{ type: 'body', parameters: [{ type: 'text', text: url }] }] : []
        await sendWhatsAppTemplate({
          phoneNumberId: wa.channel.config.phoneNumberId, accessToken: wa.channel.config.accessToken,
          to: phone, templateName: web.template.name, languageCode: web.template.language || 'es', components,
        })
        // Deja constancia en la bandeja (crea/recupera la conversación de WhatsApp).
        try {
          const convId = await flowStore.createOrGetWhatsAppConvo(accId, wa.agent.id, phone, cart.email || phone, wa.channel.id)
          if (convId) await flowStore.appendMsg(accId, wa.agent.id, convId, { sender: 'ai', content: `🛒 Plantilla de recuperación de carrito enviada${url ? `\n${url}` : ''}` })
          await pool.query('UPDATE abandoned_carts SET conv_id=?, reminders_sent=reminders_sent+1, last_reminder_at=? WHERE id=?', [convId || null, now, cart.id])
        } catch { await pool.query('UPDATE abandoned_carts SET reminders_sent=reminders_sent+1, last_reminder_at=? WHERE id=?', [now, cart.id]) }
        sent = true
      }
      if (!sent) { /* sin ventana abierta y sin plantilla configurada → no hay cómo contactar */ }
    } catch (e) { /* un carrito que falla no detiene el resto */ }
  }
}

async function tick() {
  let accounts = []
  try { const [r] = await pool.query('SELECT id, woocommerce FROM accounts'); accounts = r } catch { return }
  for (const a of accounts) {
    try {
      const cfg = a.woocommerce ? (typeof a.woocommerce === 'string' ? JSON.parse(a.woocommerce) : a.woocommerce) : null
      if (!cfg) continue
      const ac = store.abandonedCartCfg(cfg)
      if (!ac.web.enabled) continue
      await pullShopify(a.id, cfg).catch(() => {})
      await processAccount(a.id, cfg, ac).catch(() => {})
    } catch { /* cuenta que falla no detiene el resto */ }
  }
}

function start() {
  setTimeout(() => { tick().catch(() => {}) }, 90 * 1000).unref?.()
  setInterval(() => { tick().catch(() => {}) }, TICK_MS).unref?.()
}

module.exports = { start, tick }
