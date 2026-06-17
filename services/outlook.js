'use strict'
/**
 * Outlook / Microsoft 365 Calendar (Microsoft Graph) — 2.ª estrategia de
 * sincronización de calendario (junto a Google). Push de eventos + freeBusy.
 *
 * Config en calendar.integrations.outlook:
 *   { enabled, accessToken, refreshToken, expiresAt, clientId, clientSecret,
 *     tenant, email, calendarId, blockBusy }
 *
 * El access token se toma de la config (la capa de conexión OAuth — pendiente de
 * registrar la app en Azure — lo mantiene fresco). Si hay refreshToken + client
 * creds, se refresca on-demand. Best-effort: si no está conectado, no hace nada.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0'

async function getValidAccessToken(calendar) {
  const o = calendar.integrations?.outlook
  if (!o?.enabled || !o.accessToken) return null
  if (!o.expiresAt || Date.now() < o.expiresAt - 60000) return o.accessToken
  if (o.refreshToken && o.clientId && o.clientSecret) {
    try {
      const tenant = o.tenant || 'common'
      const body = new URLSearchParams({
        client_id: o.clientId, client_secret: o.clientSecret, grant_type: 'refresh_token',
        refresh_token: o.refreshToken, scope: 'https://graph.microsoft.com/.default offline_access',
      })
      const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.access_token) return d.access_token
    } catch { /* best-effort */ }
  }
  return o.accessToken
}

const eventsPath = (calId) => calId && calId !== 'primary' ? `/me/calendars/${calId}/events` : '/me/events'

async function createEvent(token, calId, event) {
  const res = await fetch(`${GRAPH}${eventsPath(calId)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event),
  })
  if (!res.ok) throw new Error(`Graph ${res.status}`)
  return res.json()
}
async function updateEvent(token, eventId, event) {
  const res = await fetch(`${GRAPH}/me/events/${eventId}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event),
  })
  if (!res.ok) throw new Error(`Graph ${res.status}`)
  return res.json()
}
async function deleteEvent(token, eventId) {
  await fetch(`${GRAPH}/me/events/${eventId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
}
// Bloques ocupados [{start,end}] (ISO) entre startIso y endIso para el email dado.
async function freeBusy(token, email, startIso, endIso, tz) {
  const res = await fetch(`${GRAPH}/me/calendar/getSchedule`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schedules: [email], availabilityViewInterval: 30,
      startTime: { dateTime: startIso, timeZone: tz || 'UTC' },
      endTime: { dateTime: endIso, timeZone: tz || 'UTC' },
    }),
  })
  if (!res.ok) return []
  const d = await res.json().catch(() => ({}))
  const items = d?.value?.[0]?.scheduleItems || []
  return items.map(i => ({ start: i.start?.dateTime, end: i.end?.dateTime })).filter(x => x.start && x.end)
}

module.exports = { getValidAccessToken, createEvent, updateEvent, deleteEvent, freeBusy, eventsPath }
