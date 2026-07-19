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
    calendars: cals.map(c => ({ id: c.id, name: c.name, description: c.description || '', timezone: c.timezone, bookingVars: Array.isArray(c.bookingVars) ? c.bookingVars : [] })),
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
// Resuelve una fecha del usuario EN EL SERVIDOR (la IA se equivoca calculando
// fechas). Acepta: YYYY-MM-DD, "hoy", "mañana", "pasado mañana", "en N días",
// días de la semana ("lunes", "este viernes", "próximo martes"), "el 15",
// "15 de julio [de 2026]" y "dd/mm[/yyyy]". Siempre resuelve hacia adelante.
const MONTHS_ES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 }
const DOW_MAP = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 }
const fmtYMD = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
function resolveDate(input, tz) {
  const raw = String(input || '').trim().toLowerCase()
  const s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '')   // sin tildes
  const ymd = s.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (ymd) return ymd[0]
  const today = todayInTz(tz)
  if (!s || /\bhoy\b/.test(s)) return today
  if (/pasado\s*manana/.test(s)) return addDays(today, 2)
  if (/\bmanana\b/.test(s)) return addDays(today, 1)
  const enN = s.match(/\ben\s+(\d{1,2})\s+dias?\b/)
  if (enN) return addDays(today, parseInt(enN[1], 10))
  // Día de la semana → la PRÓXIMA ocurrencia (con "próximo" y coincide hoy → +7).
  const dowM = s.match(/\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/)
  if (dowM) {
    const target = DOW_MAP[dowM[1]]
    const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay()
    let delta = (target - todayDow + 7) % 7
    if (delta === 0 && /proxim/.test(s)) delta = 7
    return addDays(today, delta)
  }
  const [ty, tm, td] = today.split('-').map(n => parseInt(n, 10))
  // "15 de julio [de 2026]"
  const dm = s.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?/)
  if (dm && MONTHS_ES[dm[2]]) {
    const d = parseInt(dm[1], 10), m = MONTHS_ES[dm[2]]
    let y = dm[3] ? parseInt(dm[3], 10) : ty
    if (!dm[3] && fmtYMD(y, m, d) < today) y += 1   // sin año y ya pasó → el próximo
    return fmtYMD(y, m, d)
  }
  // "dd/mm[/yyyy]"
  const slash = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (slash) {
    const d = parseInt(slash[1], 10), m = parseInt(slash[2], 10)
    let y = slash[3] ? parseInt(slash[3], 10) : ty
    if (y < 100) y += 2000
    if (!slash[3] && fmtYMD(y, m, d) < today) y += 1
    return fmtYMD(y, m, d)
  }
  // "el 15" / "día 15" → este mes, o el próximo si ya pasó.
  const dOnly = s.match(/\b(?:el|dia)\s+(\d{1,2})\b/) || s.match(/^(\d{1,2})$/)
  if (dOnly) {
    const d = parseInt(dOnly[1], 10)
    if (d >= 1 && d <= 31) {
      if (d >= td) return fmtYMD(ty, tm, d)
      const nm = tm === 12 ? 1 : tm + 1
      return fmtYMD(nm === 1 ? ty + 1 : ty, nm, d)
    }
  }
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

// Coincidencia de teléfonos ROBUSTA: ambos deben tener ≥8 dígitos y compartir el
// mismo sufijo de min(len,10) dígitos. Evita que un teléfono corto/erróneo del
// contacto (p. ej. una variable mal configurada) haga match con TODOS los clientes.
const phoneMatch = (bookingPhone, phone) => {
  const a = String(bookingPhone || '').replace(/[^\d]/g, '')
  const b = String(phone || '').replace(/[^\d]/g, '')
  if (a.length < 8 || b.length < 8) return false
  const n = Math.min(a.length, b.length, 10)
  return a.slice(-n) === b.slice(-n)
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
  const today = todayInTz(tz)
  const cust = await customerFromConv(accId, convId)
  const allowed = new Set(cals.map(c => c.id))
  const calName = id => cals.find(x => x.id === id)?.name || ''

  // SOLO las citas hechas DESDE ESTE CHAT. Se identifican por su vínculo con la
  // conversación (meta.conversationId === convId, guardado al agendar) o por los ids
  // registrados en local_vars._bookingIds. NO se emparejan por teléfono: así la tarjeta
  // nunca mezcla citas de otros clientes ni de otros chats del mismo cliente.
  const collected = new Map()
  const consider = async (id) => {
    if (!id || collected.has(id)) return
    let b = null
    try { b = await bookings.getBooking(accId, id) } catch {}
    if (b && allowed.has(b.calendarId)) collected.set(b.id, b)
  }
  // 1) ids vinculados a la conversación (últimos agendados desde este chat).
  try {
    const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    const ids = parseJ(c?.local_vars, {})?._bookingIds
    if (Array.isArray(ids)) for (const id of ids) await consider(id)
  } catch { /* best-effort */ }
  // 2) cualquier reserva cuyo meta.conversationId sea esta conversación (cubre el
  // historial completo, más allá de los últimos ids guardados). LIKE amplio + verificación
  // exacta en JS (evita depender de JSON_EXTRACT y comodines de LIKE).
  try {
    const [rows] = await pool.query('SELECT id, meta FROM calendar_bookings WHERE account_id=? AND meta LIKE ?', [accId, `%${convId}%`])
    for (const r of rows) {
      const m = parseJ(r.meta, {})
      if (m.conversationId === convId || m.convId === convId) await consider(r.id)
    }
  } catch { /* best-effort */ }

  const upcoming = [], past = []
  for (const b of collected.values()) {
    const item = { ...b, calendarName: calName(b.calendarId) }
    const isPast = b.date < today || ['completed', 'noshow', 'cancelled'].includes(b.status)
    if (isPast) past.push(item); else upcoming.push(item)
  }
  upcoming.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  past.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
  const map = b => ({ id: b.id, date: b.date, time: b.time, duration: Number(b.duration) || null, calendarId: b.calendarId, calendarName: b.calendarName, status: b.status || 'pending', statusLabel: STATUS_ES[b.status] || b.status || 'pendiente', clientName: b.clientName || '', notes: b.notes || '' })
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
      if (!date) return { text: `No entendí la fecha "${args.fecha || ''}". Hoy es ${today} (${tz}). Pásala tal cual la dijo el cliente ("lunes", "el 15", "15 de julio", "mañana") o como YYYY-MM-DD.` }
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
          // Vincula la reserva a la conversación ACTUAL: así las notificaciones y el
          // flujo post-reserva corren en este mismo chat (no crean una conversación
          // aparte por el teléfono del cliente) y los datos quedan aquí.
          meta: meta.convId ? { conversationId: meta.convId } : undefined,
        })
        // Vincula la cita a la CONVERSACIÓN: guarda teléfono/email del cliente y el
        // id de la reserva en local_vars. Así el panel del Inbox (📅 Citas) y
        // ver_mis_citas la encuentran aunque el chat no tenga wa_from (webchat).
        try {
          if (meta.convId) {
            const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [meta.convId, accId])
            const lv = parseJ(c?.local_vars, {})
            if (cust.phone && !lv.telefono) lv.telefono = cust.phone
            if (cust.email && !lv.email) lv.email = cust.email
            lv._bookingIds = [...new Set([...(Array.isArray(lv._bookingIds) ? lv._bookingIds : []), bk.id])].slice(-20)
            // Variables de SISTEMA de la cita (_cita_*): quedan en la conversación tras
            // agendar y se usan como cualquier variable ({{_cita_fecha}}, {{_cita_hora}}…)
            // en flujos, prompts y plantillas. Prefijo _cita_ = no chocan con otras.
            Object.assign(lv, {
              _cita_id: bk.id, _cita_cliente: cust.name || '',
              _cita_servicio: args.servicio || cal.name || '', _cita_calendario: cal.name || '',
              _cita_fecha: date, _cita_hora: time,
              _cita_telefono: cust.phone || '', _cita_email: cust.email || '',
              _cita_duracion: String(bk.duration || durMin(cal)), _cita_notas: args.nota || '',
            })
            // Campos "guardar en variable" del calendario: la IA extrae cada dato de la
            // conversación y lo pasa como argumento (dato_<slug de la etiqueta>). Se
            // guarda en la variable indicada (id personalizada o nombre de sistema).
            const bvList = Array.isArray(cal.bookingVars) ? cal.bookingVars : []
            const bvSaved = {}, bvMissing = []
            for (const bv of bvList) {
              if (!bv?.label || !bv?.variable) continue
              const pname = bookings.bookingVarParam(bv.label)
              let val = args[pname]
              // Fallback DETERMINISTA: si la IA no duplicó el dato_* pero la etiqueta
              // corresponde a un dato estándar de la cita (p.ej. "nombre paciente" ≈
              // nombre, "email paciente" ≈ email), usa ese valor directamente. Los
              // modelos suelen rellenar solo el parámetro estándar y omiten el dato_*
              // duplicado — sin este fallback, esos casos quedaban sin guardar.
              if (val === undefined || val === null || String(val).trim() === '') {
                const nl = String(bv.label).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
                if (/nombre|name/.test(nl)) val = cust.name || args.nombre
                else if (/tel|phone|cel|whats/.test(nl)) val = cust.phone || args.telefono
                else if (/mail|correo/.test(nl)) val = cust.email || args.email
                else if (/nota|coment|observa|motivo/.test(nl)) val = args.nota
                else if (/fecha|date/.test(nl)) val = date
                else if (/hora|time/.test(nl)) val = time
                else if (/servicio|calendario|agenda/.test(nl)) val = args.servicio || cal.name
              }
              if (val !== undefined && val !== null && String(val).trim() !== '') { lv[bv.variable] = val; bvSaved[bv.label] = val }
              else bvMissing.push(`${bv.label} (${pname})`)
            }
            await pool.query('UPDATE conversations SET local_vars=? WHERE id=? AND account_id=?', [JSON.stringify(lv), meta.convId, accId])
            // Diagnóstico visible en el debug del chat: cuántos datos se guardaron, cuáles
            // faltaron (la IA no los pasó) y si el calendario tenía campos configurados.
            if (bvList.length) {
              try { require('../flow/store').appendDebugEntry(accId, meta.agId, meta.convId, {
                type: bvMissing.length ? 'error' : 'flow_run',
                title: `📥 Datos a variables (agenda): ${Object.keys(bvSaved).length}/${bvList.length} guardados`,
                detail: { guardados: bvSaved, sinDatoDeLaIA: bvMissing, argsRecibidos: Object.keys(args || {}) },
              }) } catch {}
            }
          }
        } catch { /* no bloquea el agendado */ }
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

    if (fn === 'confirmar_cita') {
      const cust = await customerFromConv(accId, meta.convId, args)
      const up = await upcomingForPhone(accId, cals, cust.phone, tz)
      if (!up.length) return { text: 'No encontré una cita próxima de este cliente para confirmar. Confirma su nombre o número.' }
      const target = args.bookingId ? up.find(b => b.id === args.bookingId) : (up.length === 1 ? up[0] : null)
      if (!target) return { text: `El cliente tiene varias citas. Pregúntale cuál confirmar:\n${up.map(b => `• ${b.calendarName}: ${prettyDate(b.date)} ${b.time} (id ${b.id})`).join('\n')}` }
      if (target.status === 'confirmed') return { text: `Su cita del ${prettyDate(target.date)} ${target.time} en "${target.calendarName}" ya estaba confirmada. Agradécele.` }
      try {
        await bookings.setBookingStatus(accId, target.id, 'confirmed')
        return { text: `✅ Asistencia confirmada para la cita del ${prettyDate(target.date)} (${target.date}) ${target.time} en "${target.calendarName}". Agradécele al cliente por confirmar.` }
      } catch (e) { return { text: `No se pudo confirmar: ${e.message}.` } }
    }
  } catch (e) { return { text: `No se pudo completar la acción de agenda: ${e.message}` } }
  return { text: 'Acción de agenda no reconocida.' }
}

module.exports = { loadConfig, saveConfig, isEnabled, publicConfig, toolCall, allowedCalendars, todayInTz, bookingsForConv }
