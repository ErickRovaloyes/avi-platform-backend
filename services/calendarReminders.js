'use strict'
/**
 * Recordatorios de citas por WhatsApp — bucle que cada minuto busca reservas
 * cuya cita está a `minutesBefore` de ocurrir y envía el recordatorio una sola
 * vez (marca meta.reminderSent). La hora de la cita es wall-clock en la zona
 * horaria del calendario, así que la convertimos a un instante UTC para comparar.
 */

const pool = require('../db')
const { parseJ } = require('../utils')
const { notify } = require('./calendarNotify')

// UTC ms del instante (fecha+hora wall-clock) en una zona horaria dada.
function wallTimeToUtcMs(dateStr, timeStr, tz) {
  const naive = Date.parse(`${dateStr}T${(timeStr || '00:00')}:00Z`) // interpretado como UTC
  if (Number.isNaN(naive)) return NaN
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    const o = {}; dtf.formatToParts(new Date(naive)).forEach(p => { o[p.type] = p.value })
    const asUTC = Date.parse(`${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}Z`)
    return naive - (asUTC - naive) // resta el offset de la tz
  } catch { return naive }
}

async function tick() {
  try {
    const now = Date.now()
    const [cals] = await pool.query("SELECT id, account_id, name, timezone, notifications FROM calendars WHERE status='active'")
    const today = new Date(now).toISOString().slice(0, 10)
    for (const cr of cals) {
      const notifications = parseJ(cr.notifications, {})
      const rem = notifications.events?.reminder
      if (!rem?.enabled || !rem.template || !notifications.whatsappAgentId) continue
      const minutesBefore = Number(rem.minutesBefore) || 60
      const tz = cr.timezone || 'UTC'
      const [bks] = await pool.query(
        `SELECT * FROM calendar_bookings
         WHERE calendar_id=? AND account_id=? AND status IN ('pending','confirmed','rescheduled')
           AND date >= DATE_SUB(?, INTERVAL 1 DAY) AND date <= DATE_ADD(?, INTERVAL 2 DAY)`,
        [cr.id, cr.account_id, today, today]
      )
      for (const b of bks) {
        const meta = parseJ(b.meta, {})
        if (meta.reminderSent) continue
        const apptMs = wallTimeToUtcMs(b.date, b.time, tz)
        if (Number.isNaN(apptMs)) continue
        const fireAt = apptMs - minutesBefore * 60000
        if (now >= fireAt && now < apptMs) {
          const calendar = { id: cr.id, name: cr.name, timezone: tz, notifications }
          const booking = { id: b.id, clientName: b.client_name, clientPhone: b.client_phone, clientEmail: b.client_email, date: b.date, time: b.time }
          await notify(cr.account_id, calendar, booking, 'reminder')
          meta.reminderSent = true
          await pool.query('UPDATE calendar_bookings SET meta=? WHERE id=?', [JSON.stringify(meta), b.id])
        }
      }
    }
  } catch (e) { console.warn('[calendarReminders]', e.message) }
}

let timer = null
function start() {
  if (timer) return
  timer = setInterval(tick, 60000)
  console.log('[calendarReminders] bucle de recordatorios iniciado (cada 60s)')
}

module.exports = { start, tick, wallTimeToUtcMs }
