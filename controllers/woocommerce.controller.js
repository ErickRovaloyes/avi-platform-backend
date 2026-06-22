'use strict'
const pool = require('../db')
const { parseJ } = require('../utils')
const woo = require('../services/woocommerce')
const store = require('../flow/store')
const { sendWhatsAppText, sendMessengerText, sendInstagramText } = require('../services/metaSend')

// Entrega un texto a la conversación: queda en la bandeja/webchat (socket) y,
// si el chat es de un canal externo (WhatsApp/Messenger/IG), también se envía allí.
async function sendConversationMessage(accId, agId, convId, text) {
  if (!convId) return
  try { await store.appendMsg(accId, agId, convId, { sender: 'ai', content: text }) } catch (e) { console.warn('[woo msg]', e.message) }
  try {
    const [[c]] = await pool.query('SELECT channel_type, wa_from, messenger_from, ig_from FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!c || c.channel_type === 'webchat' || c.channel_type === 'test') return
    const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
    const channels = parseJ(ag?.channels, [])
    if (c.channel_type === 'whatsapp') {
      const cfg = (channels.find(ch => ch.type === 'whatsapp' && ch.status === 'connected') || {}).config || {}
      if (cfg.phoneNumberId && cfg.accessToken && c.wa_from) await sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: c.wa_from, text })
    } else if (c.channel_type === 'messenger') {
      const cfg = (channels.find(ch => ch.type === 'messenger' && ch.status === 'connected') || {}).config || {}
      if (cfg.pageAccessToken && c.messenger_from) await sendMessengerText({ pageAccessToken: cfg.pageAccessToken, recipientId: c.messenger_from, text })
    } else if (c.channel_type === 'instagram') {
      const cfg = (channels.find(ch => ch.type === 'instagram' && ch.status === 'connected') || {}).config || {}
      if (cfg.pageAccessToken && c.ig_from) await sendInstagramText({ pageAccessToken: cfg.pageAccessToken, recipientId: c.ig_from, text })
    }
  } catch (e) { console.warn('[woo deliver]', e.message) }
}

// ── Config (autenticado) ───────────────────────────────────────────────────────
const getConfig = async (req, res) => {
  try { res.json(woo.publicConfig(await woo.loadConfig(req.params.accId))) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// Guarda la conexión. Si secret/key vienen vacíos, se conservan los actuales
// (para no perderlos al editar). Prueba la conexión y registra el webhook.
const saveConfig = async (req, res) => {
  const { accId } = req.params
  try {
    const cur = await woo.loadConfig(accId) || {}
    const b = req.body || {}
    const cfg = {
      ...cur,
      storeUrl: (b.storeUrl ?? cur.storeUrl ?? '').trim().replace(/\/$/, ''),
      consumerKey: (b.consumerKey && b.consumerKey.trim()) || cur.consumerKey || '',
      consumerSecret: (b.consumerSecret && b.consumerSecret.trim()) || cur.consumerSecret || '',
      gateway: b.gateway || cur.gateway || { mode: 'native' },
      currency: b.currency ?? cur.currency ?? '',
      webhook: cur.webhook || null,
    }
    // Si cambia la URL/llaves, invalida el webhook anterior (apunta a otra tienda).
    if (cur.storeUrl !== cfg.storeUrl || cur.consumerKey !== cfg.consumerKey) cfg.webhook = null
    await woo.saveConfig(accId, cfg)

    // Conectada = hay URL + llaves. Probar y registrar el webhook de pago.
    let connection = { ok: false }
    if (woo.isEnabled(cfg)) {
      connection = await woo.testConnection(cfg)
      if (connection.ok && !cfg.webhook?.id) {
        try { await woo.registerWebhook(accId) } catch (e) { connection.webhookError = e.message }
      }
    }
    res.json({ ok: true, connection, config: woo.publicConfig(await woo.loadConfig(accId)) })
  } catch (e) { console.error('[woo saveConfig]', e); res.status(500).json({ error: e.message || 'Error interno' }) }
}

const testConnection = async (req, res) => {
  try { res.json(await woo.testConnection(await woo.loadConfig(req.params.accId))) }
  catch (e) { res.status(400).json({ error: e.message }) }
}

// ── Proxy público (lo usan el webchat-en-navegador y el motor) ─────────────────
const products = async (req, res) => {
  try {
    const q = req.body?.query ?? req.query.query ?? ''
    res.json({ products: await woo.searchProducts(req.params.accId, q, { limit: Number(req.body?.limit) || 8 }) })
  } catch (e) { res.status(400).json({ error: e.message }) }
}
const createOrder = async (req, res) => {
  try {
    const { items, customer, convId, agId } = req.body || {}
    res.json(await woo.createOrder(req.params.accId, { items, customer, convId, agId }))
  } catch (e) { res.status(400).json({ error: e.message }) }
}

// ── Webhook de WooCommerce (order.updated) ─────────────────────────────────────
const webhook = async (req, res) => {
  const { accId } = req.params
  res.sendStatus(200) // ACK inmediato a WooCommerce
  try {
    const cfg = await woo.loadConfig(accId)
    const sig = req.headers['x-wc-webhook-signature']
    // El "ping" de alta del webhook no trae order; lo ignoramos en silencio.
    if (!req.body || !req.body.id) return
    if (!woo.verifySignature(cfg, req.rawBody, sig)) { console.warn('[woo webhook] firma inválida', accId); return }
    const mapping = await woo.handleOrderUpdate(accId, req.body)
    if (mapping?.convId) {
      const tot = mapping.total ? ` por ${mapping.total} ${mapping.currency}`.trimEnd() : ''
      await sendConversationMessage(accId, mapping.agId, mapping.convId,
        `✅ ¡Pago confirmado! Recibimos tu pago del pedido #${mapping.orderId}${tot}. ¡Gracias por tu compra! 🎉`)
    }
  } catch (e) { console.error('[woo webhook]', e.message) }
}

module.exports = { getConfig, saveConfig, testConnection, products, createOrder, webhook, sendConversationMessage }
