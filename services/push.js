'use strict'
/**
 * Notificaciones push a la app móvil (Expo Push). Guarda los tokens por cuenta y
 * envía un push a los asesores cuando llega un mensaje del CLIENTE (sender:'user').
 * El disparo se engancha en services/socket.emit('message:new') — un solo punto
 * cubre todos los canales (WhatsApp/Messenger/Instagram/webchat/media).
 */
const pool = require('../db')
const { uid } = require('../utils')

const EXPO_URL = 'https://exp.host/--/api/v2/push/send'
const isExpoToken = (t) => /^Expo(nent)?PushToken\[/.test(String(t || ''))

async function registerToken(accId, memberId, token, platform) {
  if (!accId || !token) return
  const ts = Date.now()
  await pool.query(
    `INSERT INTO push_tokens (id, account_id, member_id, token, platform, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE account_id=VALUES(account_id), member_id=VALUES(member_id), platform=VALUES(platform), updated_at=VALUES(updated_at)`,
    ['pt_' + uid(), accId, memberId || null, token, platform || '', ts, ts]
  )
}

async function removeToken(token) {
  if (!token) return
  await pool.query('DELETE FROM push_tokens WHERE token=?', [token]).catch(() => {})
}

async function tokensForAccount(accId) {
  const [rows] = await pool.query('SELECT token FROM push_tokens WHERE account_id=?', [accId])
  return rows.map(r => r.token).filter(isExpoToken)
}

// Envía mensajes a Expo en lotes de 100 y limpia tokens dados de baja.
async function sendExpo(messages) {
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100)
    try {
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      })
      const j = await res.json().catch(() => null)
      // Limpia tokens inválidos (DeviceNotRegistered) para no reintentar siempre.
      const data = j?.data
      if (Array.isArray(data)) {
        data.forEach((r, idx) => {
          if (r?.status === 'error' && r?.details?.error === 'DeviceNotRegistered') {
            removeToken(batch[idx]?.to)
          }
        })
      }
    } catch (e) { console.warn('[push send]', e.message) }
  }
}

// Envía un push a todos los tokens de la cuenta. Devuelve cuántos se enviaron.
async function pushToAccount(accId, { title, body, data }) {
  const tokens = await tokensForAccount(accId)
  if (!tokens.length) return { sent: 0 }
  const messages = tokens.map(to => ({
    to, sound: 'default', priority: 'high', channelId: 'default',
    title: title || 'Nuevo mensaje', body: body || '', data: data || {},
  }))
  await sendExpo(messages)
  return { sent: messages.length }
}

// Disparo al llegar un mensaje del cliente. data = { accId, agId, convId, message }.
async function onInboundMessage(accId, data) {
  try {
    const msg = data?.message || {}
    const body = (msg.content && String(msg.content).slice(0, 140))
      || (msg.kind === 'audio' ? '🎤 Nota de voz'
        : msg.kind === 'image' ? '🖼 Imagen'
        : msg.kind === 'video' ? '🎬 Video'
        : msg.mediaId ? '📎 Archivo' : 'Nuevo mensaje')
    let title = 'Nuevo mensaje'
    try {
      const [[c]] = await pool.query('SELECT guest_name, wa_from FROM conversations WHERE id=? AND account_id=?', [data.convId, accId])
      title = c?.guest_name || c?.wa_from || 'Nuevo mensaje'
    } catch {}
    await pushToAccount(accId, { title, body, data: { accId, agId: data.agId, convId: data.convId, title } })
  } catch (e) { console.warn('[push inbound]', e.message) }
}

// Push de prueba (diagnóstico desde la app).
async function sendTest(accId) {
  return pushToAccount(accId, {
    title: 'Notificación de prueba ✅',
    body: 'Si ves esto, las notificaciones funcionan.',
    data: { test: true },
  })
}

module.exports = { registerToken, removeToken, tokensForAccount, onInboundMessage, sendTest, pushToAccount }
