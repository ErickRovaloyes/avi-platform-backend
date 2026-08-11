'use strict'
/**
 * Creación de tareas del CRM por parte del ASISTENTE IA (herramienta especial "tareas").
 *
 * Vive suelto en un servicio porque lo usan dos motores distintos: el del servidor
 * (flow/nodes/ai.js, canales reales) y el proxy público del navegador (webchat), y ambos
 * deben aplicar exactamente las mismas reglas de asignación y de fecha.
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')

// Mismo catálogo que frontend/src/lib/taskTypes.js — si diverge, la tarea se ve sin icono.
// `flujo` no está aquí a propósito: esas tareas las crea una persona eligiendo el flujo en
// el panel, y la IA no tiene forma de elegirlo. Si pudiera pedirlo, crearía tareas de tipo
// flujo sin flujo asignado, que no harían nada.
const TYPES = ['general', 'llamada', 'whatsapp', 'correo', 'reunion', 'seguimiento']
const PRIORITIES = ['low', 'normal', 'high']

// Desfase de una zona horaria respecto a UTC, en ms, EN ESE INSTANTE (respeta horario de
// verano). Se calcula con Intl para no depender de la zona horaria del servidor.
function tzOffsetMs(date, tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second)
    return asUtc - date.getTime()
  } catch { return 0 }
}

/**
 * "2026-08-05" + "10:30" leídos en la zona de la cuenta → epoch ms.
 * Devuelve null si la fecha no es válida (el modelo a veces escribe "mañana").
 */
function toEpoch(dateStr, timeStr, tz) {
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr || '').trim())
  if (!d) return null
  const t = /^(\d{1,2}):(\d{2})/.exec(String(timeStr || '').trim())
  const hh = t ? +t[1] : 9, mm = t ? +t[2] : 0     // sin hora → 9:00, hora habitual de trabajo
  if (hh > 23 || mm > 59) return null
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], hh, mm)
  // Dos pasadas: la primera puede caer en el lado equivocado de un cambio de hora.
  let ms = guess - tzOffsetMs(new Date(guess), tz)
  ms = guess - tzOffsetMs(new Date(ms), tz)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Crea una tarea del CRM ligada a una conversación.
 *
 * Asignación: por defecto el asesor de la conversación; si la IA indica `asignar_a`, se
 * resuelve por nombre contra los miembros activos. Sin asignado NO hay recordatorio (el
 * worker `dueTick` exige assignee_id), así que la respuesta lo dice explícitamente para que
 * el asistente pueda pedir a quién asignarla.
 */
async function createAiTask(accId, convId, args = {}, opts = {}) {
  const title = String(args.titulo || '').trim()
  if (!title) return { ok: false, text: 'No se creó la tarea: falta el título.' }
  if (!convId) return { ok: false, text: 'No se creó la tarea: no hay conversación activa.' }

  const tz = opts.timezone || 'America/Bogota'
  const description = String(args.descripcion || '').slice(0, 2000)
  const type = TYPES.includes(String(args.tipo || '').toLowerCase()) ? String(args.tipo).toLowerCase() : 'general'
  const priority = PRIORITIES.includes(String(args.prioridad || '').toLowerCase()) ? String(args.prioridad).toLowerCase() : 'normal'

  let dueAt = null, dateWarning = ''
  if (args.fecha) {
    dueAt = toEpoch(args.fecha, args.hora, tz)
    if (!dueAt) dateWarning = ` La fecha "${args.fecha}" no es válida (usa AAAA-MM-DD), así que la tarea quedó sin vencimiento.`
  }

  const [members] = await pool.query("SELECT id, name FROM members WHERE account_id=? AND status='active'", [accId])
  let assignee = null, assigneeWarning = ''
  const want = String(args.asignar_a || '').trim().toLowerCase()
  if (want) {
    assignee = members.find(m => String(m.name).toLowerCase() === want)
            || members.find(m => String(m.name).toLowerCase().includes(want))
            || null
    if (!assignee) assigneeWarning = ` No encontré a "${args.asignar_a}" entre los asesores.`
  }
  if (!assignee) {
    // Asesor del chat. Puede no existir (conversación sin asignar).
    const [[c]] = await pool.query('SELECT assigned_to FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    const a = parseJ(c?.assigned_to, null)
    if (a?.id) {
      const m = members.find(x => x.id === a.id)
      assignee = m || { id: a.id, name: a.name || '' }
    }
  }

  const id = 'task_' + uid()
  await pool.query(
    `INSERT INTO crm_tasks (id, account_id, target_type, target_id, title, description, due_at, assignee_id, assignee_name, status, priority, type, refs, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, accId, 'conversation', convId, title.slice(0, 200), description, dueAt,
     assignee?.id || null, assignee?.name || '', 'open', priority, type, JSON.stringify([]), 'ia', Date.now()]
  )

  try {
    await require('../controllers/crm.controller').logActivity({
      accId, targetType: 'conversation', targetId: convId, kind: 'task',
      title: 'Nueva tarea: ' + title, detail: assignee?.name ? `Asignada a ${assignee.name}` : '',
      authorId: null, authorName: 'Asistente IA',
    })
  } catch {}
  // Aviso por correo al asignado (si activó "Tareas → Correo" en sus notificaciones).
  if (assignee?.id) {
    try { require('./emailNotify').onTaskAssigned(accId, { taskId: id, title, assigneeId: assignee.id, dueAt }) } catch {}
  }

  let when = ''
  if (dueAt) {
    try { when = ` para el ${new Date(dueAt).toLocaleString('es', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` }
    catch { when = '' }
  }
  let text = `Tarea creada: "${title}"${when}`
  text += assignee?.name ? `, asignada a ${assignee.name}.` : '.'
  if (!assignee) text += ' Nadie la tiene asignada, así que no se enviará recordatorio; pregunta a quién asignarla si hace falta.'
  else if (!dueAt && !dateWarning) text += ' No tiene fecha de vencimiento, así que no habrá recordatorio.'
  text += assigneeWarning + dateWarning

  return { ok: true, id, taskId: id, dueAt, assigneeId: assignee?.id || null, assigneeName: assignee?.name || '', text }
}

module.exports = { createAiTask, toEpoch, TYPES, PRIORITIES }
