'use strict'
/**
 * Webhook de Google Calendar en TIEMPO REAL. Registra un canal `events.watch` por
 * cada calendario con sync de Google activo; cuando alguien crea/mueve/borra un
 * evento en Google, Google hace POST a nuestro webhook → hacemos un sync
 * INCREMENTAL (syncToken) y: (a) reflejamos cancelaciones externas en las reservas
 * de la plataforma, (b) emitimos un socket para que el calendario se refresque al
 * instante (la disponibilidad ya se recalcula en vivo con freeBusy).
 * Los canales expiran (~7 días); un worker los renueva.
 */
const pool = require('../db')
const g = require('./google')
const socket = require('./socket')
const { uid, parseJ } = require('../utils')

const TTL_SECONDS = 7 * 86400
const RENEW_WINDOW_MS = 2 * 86400 * 1000 // renovar si expira en menos de 2 días

function webhookAddress() {
  const base = (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
  return base + '/api/google/calendar/webhook'
}

// Calendarios de la plataforma con sync de Google activo.
async function calendarsWithGoogle() {
  const [rows] = await pool.query('SELECT id, account_id, integrations FROM calendars')
  const out = []
  for (const r of rows) {
    const gi = parseJ(r.integrations, {})?.google
    if (gi?.enabled) out.push({ id: r.id, accId: r.account_id, googleCalId: gi.calendarId || 'primary' })
  }
  return out
}

async function registerWatch(accId, platformCalId, googleCalId, oldChannel) {
  if (!g.isConfigured()) return
  const token = await g.getValidAccessToken(accId)
  if (oldChannel) {
    try { await g.stopChannel(token, oldChannel.channel_id, oldChannel.resource_id) } catch {}
    await pool.query('DELETE FROM google_calendar_channels WHERE channel_id=?', [oldChannel.channel_id]).catch(() => {})
  }
  const channelId = 'gcal_' + uid()
  const channelToken = uid() + uid()
  const r = await g.watchEvents(token, googleCalId, { id: channelId, address: webhookAddress(), channelToken, ttlSeconds: TTL_SECONDS })
  const syncToken = await g.getInitialSyncToken(token, googleCalId).catch(() => null)
  await pool.query(
    `INSERT INTO google_calendar_channels (channel_id, account_id, platform_calendar_id, google_calendar_id, resource_id, channel_token, sync_token, expiration, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [channelId, accId, platformCalId, googleCalId, r.resourceId || '', channelToken, syncToken, Number(r.expiration) || (Date.now() + TTL_SECONDS * 1000), Date.now()]
  )
}

// Registra los canales que faltan y renueva los que están por expirar; detiene los
// de calendarios que ya no tienen Google activo.
async function ensureWatches() {
  try {
    const cals = await calendarsWithGoogle()
    const now = Date.now()
    const activeKeys = new Set(cals.map(c => `${c.accId}|${c.id}`))
    for (const c of cals) {
      const [[ch]] = await pool.query('SELECT * FROM google_calendar_channels WHERE account_id=? AND platform_calendar_id=? ORDER BY created_at DESC LIMIT 1', [c.accId, c.id])
      if (ch && Number(ch.expiration) > now + RENEW_WINDOW_MS && ch.google_calendar_id === c.googleCalId) continue // vigente
      try { await registerWatch(c.accId, c.id, c.googleCalId, ch || null) } catch (e) { console.warn('[gcal register]', c.id, e.message) }
    }
    // Limpia canales de calendarios que desactivaron Google.
    const [chans] = await pool.query('SELECT channel_id, account_id, platform_calendar_id, resource_id FROM google_calendar_channels')
    for (const ch of chans) {
      if (activeKeys.has(`${ch.account_id}|${ch.platform_calendar_id}`)) continue
      try { const t = await g.getValidAccessToken(ch.account_id); await g.stopChannel(t, ch.channel_id, ch.resource_id) } catch {}
      await pool.query('DELETE FROM google_calendar_channels WHERE channel_id=?', [ch.channel_id]).catch(() => {})
    }
  } catch (e) { console.warn('[gcal ensureWatches]', e.message) }
}

// Procesa una notificación push de Google para un canal.
async function handleNotification(channelId, channelTokenHeader, resourceState) {
  const [[ch]] = await pool.query('SELECT * FROM google_calendar_channels WHERE channel_id=?', [channelId])
  if (!ch) return
  if (ch.channel_token && channelTokenHeader && ch.channel_token !== channelTokenHeader) return // token no coincide → ignorar
  if (resourceState === 'sync') return // primera notificación (handshake), sin cambios
  try {
    const token = await g.getValidAccessToken(ch.account_id)
    let { items, nextSyncToken, expired } = await g.listChanges(token, ch.google_calendar_id, ch.sync_token)
    if (expired) { nextSyncToken = await g.getInitialSyncToken(token, ch.google_calendar_id).catch(() => null); items = [] }
    if (nextSyncToken) await pool.query('UPDATE google_calendar_channels SET sync_token=? WHERE channel_id=?', [nextSyncToken, channelId])
    await processChanges(ch.account_id, items)
    socket.emit(ch.account_id, 'calendar:updated', { calendarId: ch.platform_calendar_id, source: 'google' })
  } catch (e) { console.warn('[gcal handleNotification]', e.message) }
}

// Refleja en la plataforma los cambios externos relevantes (cancelaciones de
// eventos que correspondían a reservas creadas por la plataforma).
async function processChanges(accId, items) {
  for (const ev of (items || [])) {
    if (!ev?.id) continue
    if (ev.status === 'cancelled') {
      await pool.query("UPDATE calendar_bookings SET status='cancelled' WHERE account_id=? AND external_id=? AND status<>'cancelled'", [accId, ev.id]).catch(() => {})
    }
  }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(() => ensureWatches().catch(() => {}), 30 * 60 * 1000) // cada 30 min: registra/renueva
  _timer.unref?.()
  setTimeout(() => ensureWatches().catch(() => {}), 45000) // primer pase a los 45s
}

module.exports = { ensureWatches, handleNotification, registerWatch, startWorker }
