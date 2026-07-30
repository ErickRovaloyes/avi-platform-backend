'use strict'
/**
 * Tareas periódicas del CRM — plantillas que generan una tarea cada cierto tiempo.
 * Un worker revisa las programaciones activas y, cuando `next_at <= ahora`, crea la
 * tarea (crm_tasks) y recalcula la próxima fecha según la frecuencia.
 */
const pool = require('../db')
const { uid } = require('../utils')

const DAY = 86400000

// Próxima ocurrencia (ms) a partir de `from` según la frecuencia. Mantiene la hora
// de `from` (o de la programación inicial) y solo avanza la fecha.
function computeNextAt(sched, from = Date.now()) {
  const freq = sched.freq || 'weekly'
  const step = Math.max(1, Number(sched.interval_n) || 1)
  const base = new Date(from)
  if (freq === 'daily') {
    base.setDate(base.getDate() + step)
    return base.getTime()
  }
  if (freq === 'weekly') {
    const wd = Number.isInteger(sched.weekday) ? sched.weekday : base.getDay()  // 0=domingo
    // Avanza al menos un día y luego al próximo `wd`; respeta el intervalo de semanas.
    const d = new Date(from); d.setDate(d.getDate() + 1)
    while (d.getDay() !== wd) d.setDate(d.getDate() + 1)
    if (step > 1) d.setDate(d.getDate() + (step - 1) * 7)
    return d.getTime()
  }
  // monthly
  const md = Math.min(28, Math.max(1, Number(sched.monthday) || base.getDate()))
  const d = new Date(from)
  d.setMonth(d.getMonth() + step)
  d.setDate(md)
  return d.getTime()
}

// next_at inicial al crear/editar: la próxima ocurrencia desde ahora.
function initialNextAt(sched) {
  return computeNextAt(sched, Date.now())
}

async function tick() {
  try {
    const now = Date.now()
    const [rows] = await pool.query(
      'SELECT * FROM crm_task_schedules WHERE enabled=1 AND next_at IS NOT NULL AND next_at<=? LIMIT 200', [now])
    for (const sc of rows) {
      try {
        await pool.query(
          'INSERT INTO crm_tasks (id, account_id, target_type, target_id, title, description, due_at, assignee_id, assignee_name, status, priority, type, refs, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ['task_' + uid(), sc.account_id, sc.target_type || null, sc.target_id || null,
            sc.title || 'Tarea periódica', sc.description || '',
            null, sc.assignee_id || null, sc.assignee_name || '',
            'open', sc.priority || 'normal', sc.type || 'general', '[]', '🔁 Periódica', now])
        const next = computeNextAt(sc, now)
        await pool.query('UPDATE crm_task_schedules SET last_spawned_at=?, next_at=? WHERE id=?', [now, next, sc.id])
      } catch (e) { console.warn('[task schedule]', sc.id, e.message) }
    }
  } catch (e) { console.warn('[task schedules tick]', e.message) }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(() => tick().catch(() => {}), 5 * 60000)  // cada 5 min
  _timer.unref?.()
  setTimeout(() => tick().catch(() => {}), 40000)                 // primer pase a los 40s
}

module.exports = { computeNextAt, initialNextAt, tick, startWorker }
