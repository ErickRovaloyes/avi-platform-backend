'use strict'
/**
 * Canal de WhatsApp EXCLUSIVO del Copiloto de negocio. Quien escribe a ese número
 * habla con el copiloto (businessCopilot), pero cada número nuevo debe poner una
 * CONTRASEÑA (configurable en la cuenta). A los 3 intentos fallidos, el número se
 * BLOQUEA (no vuelve a recibir respuesta). Estado por número en `copilot_wa_auth`.
 */
const pool = require('../db')
const { parseJ } = require('../utils')
const businessCopilot = require('./businessCopilot')
const { sendWhatsAppText } = require('./metaSend')

const MAX_ATTEMPTS = 3

async function accountCfg(accId) {
  try { const [[a]] = await pool.query('SELECT copilot_wa FROM accounts WHERE id=?', [accId]); return parseJ(a?.copilot_wa, {}) || {} }
  catch { return {} }
}
async function getState(accId, phone) {
  try { const [[r]] = await pool.query('SELECT * FROM copilot_wa_auth WHERE account_id=? AND phone=?', [accId, phone]); return r || null }
  catch { return null }
}
async function setState(accId, phone, status, attempts) {
  const now = Date.now()
  await pool.query(
    `INSERT INTO copilot_wa_auth (account_id, phone, status, attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status), attempts=VALUES(attempts), updated_at=VALUES(updated_at)`,
    [accId, phone, status, attempts, now, now]
  ).catch(() => {})
}

// Entrega un texto: queda en la bandeja (appendMsg) y se envía por WhatsApp.
async function reply(accId, agentId, convId, channel, phone, text) {
  try { await require('../flow/store').appendMsg(accId, agentId, convId, { sender: 'ai', content: text, channel: 'whatsapp', channelId: channel?.id }) } catch {}
  const cfg = channel?.config || {}
  if (cfg.phoneNumberId && cfg.accessToken && phone) {
    try { await sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: phone, text }) } catch (e) { console.warn('[copilotWA send]', e.message) }
  }
}

async function answer(accId, agentId, convId, channel, phone, question) {
  if (!question) return
  let text
  try { const r = await businessCopilot.ask(accId, question); text = r?.ok ? (r.answer || 'No tengo datos para responder eso.') : ('⚠️ ' + (r?.error || 'No pude responder.')) }
  catch { text = '⚠️ Error al consultar el copiloto de negocio.' }
  await reply(accId, agentId, convId, channel, phone, text)
}

// Procesa un mensaje entrante del canal-copiloto (el mensaje del usuario ya se guardó).
async function handle(accId, agentId, channel, msg, convId) {
  const phone = String(msg.from || '').replace(/[^\d]/g, '')
  const text = (msg.text || '').trim()
  const cfg = await accountCfg(accId)
  const password = String(cfg.password || '')
  const st = await getState(accId, phone)

  if (st?.status === 'blocked') return   // número bloqueado → no responde

  // Sin contraseña configurada → el copiloto responde directamente.
  if (!password) {
    if (st?.status !== 'authed') await setState(accId, phone, 'authed', 0)
    return answer(accId, agentId, convId, channel, phone, text)
  }

  // No autenticado: pide/valida la contraseña.
  if (!st || st.status === 'pending') {
    if (!st) {
      await setState(accId, phone, 'pending', 0)
      return reply(accId, agentId, convId, channel, phone, '🔒 Este canal es privado. Escribe la *contraseña* para continuar:')
    }
    if (text === password) {
      await setState(accId, phone, 'authed', 0)
      return reply(accId, agentId, convId, channel, phone, '✅ ¡Acceso concedido! Soy el *Copiloto de negocio*. Pregúntame por tus ventas, clientes, atención, pipeline o citas.')
    }
    const attempts = (st.attempts || 0) + 1
    if (attempts >= MAX_ATTEMPTS) {
      await setState(accId, phone, 'blocked', attempts)
      return reply(accId, agentId, convId, channel, phone, '⛔ Número bloqueado por 3 intentos fallidos de contraseña.')
    }
    await setState(accId, phone, 'pending', attempts)
    return reply(accId, agentId, convId, channel, phone, `❌ Contraseña incorrecta. Te quedan ${MAX_ATTEMPTS - attempts} intento(s).`)
  }

  // Autenticado → responde el copiloto.
  return answer(accId, agentId, convId, channel, phone, text)
}

// Gestión (panel de cuenta): listar y desbloquear números.
async function listAuth(accId) {
  try { const [rows] = await pool.query('SELECT phone, status, attempts, updated_at FROM copilot_wa_auth WHERE account_id=? ORDER BY updated_at DESC LIMIT 500', [accId]); return rows }
  catch { return [] }
}
async function unblock(accId, phone) {
  await pool.query('DELETE FROM copilot_wa_auth WHERE account_id=? AND phone=?', [accId, String(phone).replace(/[^\d]/g, '')]).catch(() => {})
  return { ok: true }
}

module.exports = { handle, listAuth, unblock }
