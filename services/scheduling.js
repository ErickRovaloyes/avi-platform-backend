'use strict'
/**
 * Herramienta IA Especial de AGENDA. Reutiliza services/bookings (disponibilidad,
 * crear, reagendar, cancelar). El cliente elige en su panel QUÉ calendario(s)
 * puede usar el asistente; cada calendario tiene una DESCRIPCIÓN que el agente IA
 * usa para elegir entre uno u otro. Funciones que expone:
 *   ver_disponibilidad · recomendar_citas · agendar_cita · mover_cita · cancelar_cita
 * Todo pasa por el servidor (el navegador no toca la BD de reservas).
 */
const pool = require('../db')
const { parseJ } = require('../utils')
const bookings = require('./bookings')

const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

// ── Config por cuenta ──────────────────────────────────────────────────────────
async function loadConfig(accId) {
  try { const [[a]] = await pool.query('SELECT scheduling FROM accounts WHERE id=?', [accId]); return parseJ(a?.scheduling, null) }
  catch { return null }
}
async function saveConfig(accId, cfg) { await pool.query('UPDATE accounts SET scheduling=? WHERE id=?', [JSON.stringify(cfg || {}), accId]) }
function isEnabled(cfg) { return !!(cfg && Array.isArray(cfg.calendarIds) && cfg.calendarIds.length) }

// Config pública: incluye los calendarios elegidos con su DESCRIPCIÓN (para que el
// nodo IA se la dé al modelo y elija el correcto). Async porque lista calendarios.
async function publicConfig(accId) {
  const cfg = await loadConfig(accId) || {}
  const ids = Array.isArray(cfg.calendarIds) ? cfg.calendarIds : []
  if (!ids.length) return { connected: false, calendarIds: [], calendars: [], timezone: cfg.timezone || '' }
  let cals = []
  try { cals = (await bookings.listCalendars(accId)).filter(c => ids.includes(c.id)) } catch { cals = [] }
  return {
    connected: cals.length > 0,
    calendarIds: cals.map(c => c.id),
    calendars: cals.map(c => ({ id: c.id, name: c.name, description: c.description || '', timezone: c.timezone })),
    timezone: cals[0]?.timezone || cfg.timezone || 'America/Lima',
  }
}

// ── Helpers de fecha (en la zona horaria del calendario) ───────────────────────
function todayInTz(tz) {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: tz || 'America/Lima' }) } // YYYY-MM-DD
  catch { return new Date().toISOString().slice(0, 10) }
}
function addDays(dateStr, n) { const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
function dowName(dateStr) { try { return DAYS_ES[new Date(`${dateStr}T12:00:00Z`).getUTCDay()] } catch { return '' } }
function prettyDate(dateStr) { const [y, m, d] = dateStr.split('-'); return `${dowName(dateStr)} ${d}/${m}` }
// Resuelve una fecha del usuario: YYYY-MM-DD, "hoy", "mañana", "pasado mañana".
function resolveDate(input, tz) {
  const s = String(input || '').trim().toLowerCase()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const today = todayInTz(tz)
  if (!s || s === 'hoy') return today
  if (s === 'mañana' || s === 'manana') return addDays(today, 1)
  if (s.includes('pasado')) return addDays(today, 2)
  return null
}

// ── Resolución de calendario por nombre/descripción ────────────────────────────
async function allowedCalendars(accId) {
  const cfg = await loadConfig(accId)
  const ids = cfg?.calendarIds || []
  if (!ids.length) return []
  try { return (await bookings.listCalendars(accId)).filter(c => ids.includes(c.id) && c.status !== 'inactive') }
  catch { return [] }
}
function pickCalendar(cals, servicio) {
  if (cals.length === 1) return cals[0]
  if (!cals.length) return null
  const q = String(servicio || '').trim().toLowerCase()
  if (!q) return null
  // Por nombre primero, luego por palabras de la descripción.
  let best = cals.find(c => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()))
  if (best) return best
  const tokens = q.split(/[^a-z0-9áéíóúñü]+/i).filter(w => w.length > 2)
  let bestScore = 0
  for (const c of cals) {
    const hay = `${c.name} ${c.description || ''}`.toLowerCase()
    const score = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
    if (score > bestScore) { bestScore = score; best = c }
  }
  return bestScore > 0 ? best : null
}
function calendarMenu(cals) {
  return cals.map(c => `• ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n')
}

// Datos del cliente desde la conversación (para agendar/identificar reservas).
async function customerFromConv(accId, convId, args = {}) {
  let conv = null
  try { if (convId) { const [[c]] = await pool.query('SELECT guest_name, wa_from, local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId]); conv = c } } catch {}
  const lv = parseJ(conv?.local_vars, {})
  const digits = s => String(s || '').replace(/[^\d]/g, '')
  return {
    name: String(args.nombre || lv.var_nombre || conv?.guest_name || '').trim(),
    phone: digits(args.telefono || conv?.wa_from || lv.telefono || lv.var_telefono || ''),
    email: String(args.email || lv.email || lv.var_email || '').trim(),
  }
}

const phoneMatch = (bookingPhone, phone) => {
  const a = String(bookingPhone || '').replace(/[^\d]/g, '')
  if (!a || !phone) return false
  return a.endsWith(phone.slice(-8)) || phone.endsWith(a.slice(-8))
}

// Reservas próximas (activas) del cliente, por teléfono, en los calendarios permitidos.
async function upcomingForPhone(accId, cals, phone, tz) {
  if (!phone) return []
  const today = todayInTz(tz)
  const out = []
  for (const c of cals) {
    let list = []
    try { list = await bookings.listBookings(accId, c.id, { from: today, q: phone }) } catch {}
    for (const b of list) {
      if (['cancelled', 'noshow', 'completed'].includes(b.status)) continue
      if (phoneMatch(b.clientPhone, phone)) out.push({ ...b, calendarName: c.name })
    }
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
}

// TODAS las reservas del cliente (por teléfono) → separadas en próximas y pasadas.
async function allForPhone(accId, cals, phone, tz) {
  if (!phone) return { upcoming: [], past: [] }
  const today = todayInTz(tz)
  const upcoming = [], past = []
  for (const c of cals) {
    let list = []
    try { list = await bookings.listBookings(accId, c.id, { q: phone }) } catch {}
    for (const b of list) {
      if (!phoneMatch(b.clientPhone, phone)) continue
      const item = { ...b, calendarName: c.name }
      const isPast = b.date < today || ['completed', 'noshow', 'cancelled'].includes(b.status)
      if (isPast) past.push(item); else upcoming.push(item)
    }
  }
  upcoming.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  past.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)) // más reciente primero
  return { upcoming, past }
}
const STATUS_ES = { pending: 'pendiente', confirmed: 'confirmada', rescheduled: 'reagendada', cancelled: 'cancelada', noshow: 'no asistió', completed: 'completada' }

// Citas de la conversación (para el panel lateral del Inbox): resuelve el cliente
// desde la conversación (teléfono/nombre) y devuelve sus reservas próximas y pasadas
// en los calendarios habilitados. Misma lógica que usa el asistente (ver_mis_citas).
async function bookingsForConv(accId, convId) {
  const cals = await allowedCalendars(accId)
  if (!cals.length) return { enabled: false, customer: null, upcoming: [], past: [] }
  const tz = cals[0].timezone || 'America/Lima'
  const cust = await customerFromConv(accId, convId)
  if (!cust.phone) return { enabled: true, customer: cust, upcoming: [], past: [] }
  const { upcoming, past } = await allForPhone(accId, cals, cust.phone, tz)
  const map = b => ({ id: b.id, date: b.date, time: b.time, calendarName: b.calendarName, status: b.status || 'pending', statusLabel: STATUS_ES[b.status] || b.status || 'pendiente', clientName: b.clientName || '', notes: b.notes || '' })
  return { enabled: true, customer: cust, upcoming: upcoming.map(map), past: past.slice(0, 10).map(map) }
}

// ── Dispatcher de funciones (lo llaman el nodo IA del servidor y el proxy) ──────
async function toolCall(accId, fn, args = {}, meta = {}) {
  const cals = await allowedCalendars(accId)
  if (!cals.length) return { text: 'No hay calendarios configurados para la agenda. El cliente debe seleccionarlos en su panel (Zona IA → Agenda).' }
  const tz = cals[0].timezone || 'America/Lima'
  const today = todayInTz(tz)
  // Duración de cada cita/turno del calendario (min). El asistente la necesita para
  // no inventarse la duración (ej. decir 1h cuando son 30 min).
  const durMin = c => Number(c?.appointment?.defaultDuration) || 30

  // Elegir calendario (por nombre/descripción) cuando hay varios.
  function resolveCal(needList) {
    if (cals.length === 1) return cals[0]
    const c = pickCalendar(cals, args.servicio || args.calendario)
    return c
  }

  try {
    if (fn === 'ver_disponibilidad') {
      const cal = resolveCal()
      if (!cal) return { text: `Hay varios calendarios. Pregúntale al cliente cuál necesita (indica "servicio"). Opciones:\n${calendarMenu(cals)}` }
      const date = resolveDate(args.fecha, tz)
      if (!date) return { text: `No entendí la fecha. Hoy es ${today} (${tz}). Pide una fecha (YYYY-MM-DD) o "hoy/mañana".` }
      const slots = await bookings.getAvailability(accId, cal.id, date)
      const times = (Array.isArray(slots) ? slots : (slots?.slots || [])).map(s => typeof s === 'string' ? s : s.time).filter(Boolean)
      if (!times.length) return { text: `Sin horarios libres en "${cal.name}" para ${prettyDate(date)} (${date}). Sugiere otra fecha o usa recomendar_citas.` }
      return { text: `Disponibilidad de "${cal.name}" para ${prettyDate(date)} (${date}). Cada cita dura ${durMin(cal)} minutos; los horarios de abajo son las horas de INICIO (informa al cliente la duración de ${durMin(cal)} min y NO ofrezcas otras duraciones):\n${times.slice(0, 24).join(', ')}` }
    }

    if (fn === 'recomendar_citas') {
      const cal = resolveCal()
      const list = cal ? [cal] : cals
      const out = []
      for (const c of list) {
        let scanned = 0, found = 0
        for (let i = 0; i < 21 && found < 3; i++) {
          const d = addDays(today, i)
          let slots = []
          try { slots = await bookings.getAvailability(accId, c.id, d) } catch {}
          const times = (Array.isArray(slots) ? slots : (slots?.slots || [])).map(s => typeof s === 'string' ? s : s.time).filter(Boolean)
          if (times.length) { out.push(`• ${c.name} (cada cita dura ${durMin(c)} min): ${prettyDate(d)} (${d}) → ${times.slice(0, 3).join(', ')}`); found++ }
          if (++scanned > 21) break
        }
      }
      if (!out.length) return { text: 'No encontré disponibilidad próxima en los calendarios. Sugiere contactar para revisar manualmente.' }
      return { text: `Próximas disponibilidades (hoy es ${today}). Los horarios son de INICIO; informa siempre al cliente la duración indicada de cada cita:\n${out.join('\n')}` }
    }

    if (fn === 'agendar_cita') {
      const cal = resolveCal()
      if (!cal) return { text: `Hay varios calendarios. Pregunta cuál servicio necesita el cliente. Opciones:\n${calendarMenu(cals)}` }
      const date = resolveDate(args.fecha, tz)
      const time = String(args.hora || '').slice(0, 5)
      if (!date || !/^\d{2}:\d{2}$/.test(time)) return { text: `Faltan fecha y hora válidas (hoy es ${today}). Confirma con el cliente día y hora exactos.` }
      const cust = await customerFromConv(accId, meta.convId, args)
      if (!cust.name) return { text: 'Falta el nombre del cliente para agendar. Pídelo.' }
      try {
        const bk = await bookings.createBooking(accId, cal.id, {
          date, time, clientName: cust.name, clientPhone: cust.phone, clientEmail: cust.email,
          channel: 'ia', notes: args.nota || '',
        })
        return { text: `✅ Cita agendada en "${cal.name}" para ${cust.name} el ${prettyDate(date)} (${date}) a las ${time} (duración ${durMin(cal)} min). (id ${bk.id})` }
      } catch (e) { return { text: `No se pudo agendar: ${e.message}. Ofrece otro horario o usa ver_disponibilidad.` } }
    }

    if (fn === 'ver_mis_citas') {
      const cust = await customerFromConv(accId, meta.convId, args)
      if (!cust.phone) return { text: 'Para ver tus citas necesito tu número de teléfono. Pídeselo al cliente.' }
      const { upcoming, past } = await allForPhone(accId, cals, cust.phone, tz)
      if (!upcoming.length && !past.length) return { text: `No encontré citas registradas para ese cliente (tel ${cust.phone}).` }
      const fmt = b => `• ${prettyDate(b.date)} (${b.date}) ${b.time} · ${b.calendarName}${b.status && b.status !== 'pending' && b.status !== 'confirmed' ? ` [${STATUS_ES[b.status] || b.status}]` : ''}`
      let txt = ''
      txt += upcoming.length ? `CITAS ACTIVAS / PRÓXIMAS:\n${upcoming.map(fmt).join('\n')}` : 'No tiene citas activas próximas.'
      if (past.length) txt += `\n\nCITAS ANTERIORES (${past.length}):\n${past.slice(0, 10).map(fmt).join('\n')}`
      return { text: txt }
    }

    if (fn === 'mover_cita') {
      const cust = await customerFromConv(accId, meta.convId, args)
      const up = await upcomingForPhone(accId, cals, cust.phone, tz)
      if (!up.length) return { text: 'No encontré una cita próxima de este cliente para mover. Pídele el nombre/fecha o que confirme su número.' }
      const target = args.bookingId ? up.find(b => b.id === args.bookingId) : (up.length === 1 ? up[0] : null)
      if (!target) return { text: `El cliente tiene varias citas próximas. Pregúntale cuál mover:\n${up.map(b => `• ${b.calendarName}: ${prettyDate(b.date)} ${b.time} (id ${b.id})`).join('\n')}` }
      const date = resolveDate(args.nueva_fecha, tz)
      const time = String(args.nueva_hora || '').slice(0, 5)
      if (!date || !/^\d{2}:\d{2}$/.test(time)) return { text: `Indica la nueva fecha y hora (hoy es ${today}).` }
      try {
        await bookings.rescheduleBooking(accId, target.id, date, time)
        return { text: `✅ Cita movida a ${prettyDate(date)} (${date}) a las ${time} en "${target.calendarName}".` }
      } catch (e) { return { text: `No se pudo mover: ${e.message}.` } }
    }

    if (fn === 'cancelar_cita') {
      const cust = await customerFromConv(accId, meta.convId, args)
      const up = await upcomingForPhone(accId, cals, cust.phone, tz)
      if (!up.length) return { text: 'No encontré una cita próxima de este cliente para cancelar. Confirma su nombre o número.' }
      const target = args.bookingId ? up.find(b => b.id === args.bookingId) : (up.length === 1 ? up[0] : null)
      if (!target) return { text: `El cliente tiene varias citas. Pregúntale cuál cancelar:\n${up.map(b => `• ${b.calendarName}: ${prettyDate(b.date)} ${b.time} (id ${b.id})`).join('\n')}` }
      try {
        await bookings.cancelBooking(accId, target.id)
        return { text: `✅ Cita cancelada: ${prettyDate(target.date)} ${target.time} en "${target.calendarName}".` }
      } catch (e) { return { text: `No se pudo cancelar: ${e.message}.` } }
    }
  } catch (e) { return { text: `No se pudo completar la acción de agenda: ${e.message}` } }
  return { text: 'Acción de agenda no reconocida.' }
}

module.exports = { loadConfig, saveConfig, isEnabled, publicConfig, toolCall, allowedCalendars, todayInTz, bookingsForConv }
