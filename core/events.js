'use strict'
/**
 * Core Booking Engine — Outbox de eventos de dominio (Fase 0).
 *
 * Patrón Outbox: las mutaciones del dominio (crear/reagendar/cancelar reserva,
 * más adelante check-in, asignar mesa, reservar asiento…) registran un evento en
 * la tabla `domain_events`. Un procesador en segundo plano lo entrega a los
 * handlers registrados (notificaciones, sync de calendario, webhooks, reportes).
 *
 * Desde la Fase 1 los side-effects (notify de reservas + sync a Google Calendar)
 * se ejecutan como HANDLERS del outbox (registrados desde services/bookings.js),
 * no inline. Procesamiento inmediato (kick tras emit) + reintentos en el bucle de
 * 5s → más fiable que el fire-and-forget anterior (visibilidad + retry). Queda
 * listo para publicar a un bus externo (Kafka/SQS) sin tocar el dominio.
 *
 * Tipos de evento del núcleo: BookingCreated, BookingRescheduled,
 * BookingCancelled, BookingConfirmed, BookingNoShow, BookingCompleted.
 */

const pool = require('../db')
const { parseJ } = require('../utils')

// type -> [handler(event)]
const handlers = Object.create(null)

// Registra un consumidor para un tipo de evento. Idempotente por diseño: cada
// handler debe tolerar reentregas (dedupe por event.id si hace efectos externos).
function on(type, fn) {
  (handlers[type] || (handlers[type] = [])).push(fn)
}

// Emite (registra) un evento. Best-effort: nunca lanza para no romper la
// transacción de negocio que lo originó.
async function emit(type, { accId = null, agId = null, vertical = 'appointment', aggregateId = null, payload = {} } = {}) {
  try {
    await pool.query(
      'INSERT INTO domain_events (account_id, agent_id, vertical, type, aggregate_id, payload, status, ts) VALUES (?,?,?,?,?,?,?,?)',
      [accId, agId, vertical, type, aggregateId, JSON.stringify(payload || {}), 'pending', Date.now()]
    )
    kick() // procesamiento inmediato (no bloquea al emisor)
  } catch (e) {
    console.warn('[events.emit]', type, e.message)
  }
}

const MAX_ATTEMPTS = 8
let _running = false // single-flight: evita que el kick y el bucle solapen

// Procesa los eventos pendientes y los marca done / pending(retry) / error.
async function processPending(limit = 100) {
  if (_running) return 0
  _running = true
  try {
    let rows
    try {
      [rows] = await pool.query("SELECT * FROM domain_events WHERE status='pending' ORDER BY id ASC LIMIT ?", [limit])
    } catch { return 0 }
    for (const ev of rows || []) {
      const fns = handlers[ev.type] || []
      let ok = true
      if (fns.length) {
        const event = { id: ev.id, type: ev.type, accId: ev.account_id, agId: ev.agent_id, vertical: ev.vertical, aggregateId: ev.aggregate_id, payload: parseJ(ev.payload, {}), ts: ev.ts }
        for (const fn of fns) {
          try { await fn(event) } catch (e) { ok = false; console.warn('[event handler]', ev.type, e.message) }
        }
      }
      // done | pending(reintenta en el próximo tick) | error(agotó intentos)
      const nextStatus = ok ? 'done' : ((ev.attempts + 1) >= MAX_ATTEMPTS ? 'error' : 'pending')
      try {
        await pool.query('UPDATE domain_events SET status=?, attempts=attempts+1, processed_at=? WHERE id=?',
          [nextStatus, Date.now(), ev.id])
      } catch { /* non-critical */ }
    }
    return (rows || []).length
  } finally { _running = false }
}

function kick() { setImmediate(() => { processPending().catch(() => {}) }) }

let _timer = null
// Arranca el bucle del procesador (idempotente). intervalMs por defecto 5s.
function startProcessor(intervalMs = 5000) {
  if (_timer) return
  _timer = setInterval(() => { processPending().catch(() => {}) }, intervalMs)
  if (_timer.unref) _timer.unref()
  console.log('[events] outbox processor iniciado')
}

module.exports = { emit, on, processPending, startProcessor }
