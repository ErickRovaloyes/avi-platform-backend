'use strict'
/**
 * Controlador de la PASARELA DE PAGO general.
 *   - Config (autenticado): conectar/guardar/probar el proveedor (Wompi, …).
 *   - Proxy público (webchat-en-navegador + motor): crear link / consultar estado.
 *   - Webhook (público): el proveedor avisa de la transacción → confirma el pago,
 *     avisa en el chat y dispara el flujo de ÉXITO o de FALLO configurado.
 */
const pool = require('../db')
const { parseJ } = require('../utils')
const payments = require('../services/payments')
const { sendConversationMessage } = require('./woocommerce.controller')

// ── Config (autenticado) ────────────────────────────────────────────────────
const getConfig = async (req, res) => {
  try { res.json(payments.publicConfig(await payments.loadConfig(req.params.accId))) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

const saveConfig = async (req, res) => {
  const { accId } = req.params
  try {
    const cur = await payments.loadConfig(accId) || {}
    const b = req.body || {}
    const cfg = {
      ...cur,
      provider: b.provider || cur.provider || 'wompi',
      mode: b.mode === 'sandbox' ? 'sandbox' : (b.mode === 'production' ? 'production' : (cur.mode || 'production')),
      currency: (b.currency ?? cur.currency ?? 'COP').toUpperCase(),
      // Secretos: si vienen vacíos, se conservan los actuales.
      publicKey: (b.publicKey && b.publicKey.trim()) || cur.publicKey || '',
      privateKey: (b.privateKey && b.privateKey.trim()) || cur.privateKey || '',
      eventsSecret: (b.eventsSecret && b.eventsSecret.trim()) || cur.eventsSecret || '',
      // Flujos disparados al confirmarse / rechazarse el pago.
      successFlowId: b.successFlowId !== undefined ? (b.successFlowId || null) : (cur.successFlowId || null),
      failureFlowId: b.failureFlowId !== undefined ? (b.failureFlowId || null) : (cur.failureFlowId || null),
    }
    await payments.saveConfig(accId, cfg)
    let connection = { ok: false }
    if (payments.isEnabled(cfg)) connection = await payments.testConnection(cfg)
    res.json({ ok: true, connection, config: payments.publicConfig(await payments.loadConfig(accId)) })
  } catch (e) { console.error('[payments saveConfig]', e); res.status(500).json({ error: e.message || 'Error interno' }) }
}

const testConnection = async (req, res) => {
  try { res.json(await payments.testConnection(await payments.loadConfig(req.params.accId))) }
  catch (e) { res.status(400).json({ error: e.message }) }
}

// ── Proxy público (webchat-en-navegador + motor) ────────────────────────────
const createLink = async (req, res) => {
  try {
    const { amount, description, currency, convId, agId } = req.body || {}
    res.json(await payments.createPaymentLink(req.params.accId, { amount, description, currency, convId, agId }))
  } catch (e) { res.status(400).json({ error: e.message }) }
}

const status = async (req, res) => {
  try {
    const row = await payments.latestIntentStatus(req.params.accId, req.body?.convId)
    if (!row) return res.json({ found: false })
    res.json({ found: true, status: row.status, amount: row.amount, currency: row.currency, reference: row.reference, paid: row.status === 'approved' })
  } catch (e) { res.status(400).json({ error: e.message }) }
}

// ── Webhook (público, sin auth) ─────────────────────────────────────────────
const webhook = async (req, res) => {
  const { accId } = req.params
  res.sendStatus(200) // ACK inmediato al proveedor
  try {
    const out = await payments.handleWebhook(accId, req.body)
    if (!out?.matched) return
    const intent = out.intent
    const convId = intent.conv_id, agId = intent.agent_id
    const amt = `${intent.amount} ${intent.currency}`
    if (convId) {
      const msg = out.status === 'approved'
        ? `✅ ¡Pago confirmado! Recibimos tu pago de ${amt}. ¡Gracias! 🎉`
        : `⚠️ Tu pago de ${amt} no se pudo procesar. Puedes intentarlo de nuevo cuando quieras.`
      await sendConversationMessage(accId, agId, convId, msg).catch(() => {})
      // Variables disponibles para el flujo disparado.
      await mergeLocalVars(accId, convId, {
        pago_estado: out.status, pago_monto: String(intent.amount),
        pago_moneda: intent.currency, pago_referencia: intent.reference,
        pago_transaccion: String(out.transaction?.id || ''),
      }).catch(() => {})
    }
    // Dispara el flujo configurado (éxito / fallo) en la conversación.
    if (out.flowId && convId) {
      try {
        const { executeFlow } = require('../flow/engine')
        await executeFlow({
          flowId: out.flowId, accId, agId, convId,
          triggerContext: { source: 'payment', status: out.status, reference: intent.reference, amount: intent.amount, currency: intent.currency },
        })
      } catch (e) { console.warn('[payment flow]', e.message) }
    }
  } catch (e) { console.error('[payments webhook]', e.message) }
}

// Mezcla variables en conversations.local_vars (no pisa otras).
async function mergeLocalVars(accId, convId, vars) {
  const [[cv]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
  const lv = parseJ(cv?.local_vars, {})
  Object.assign(lv, vars)
  await pool.query('UPDATE conversations SET local_vars=? WHERE id=? AND account_id=?', [JSON.stringify(lv), convId, accId])
}

module.exports = { getConfig, saveConfig, testConnection, createLink, status, webhook }
