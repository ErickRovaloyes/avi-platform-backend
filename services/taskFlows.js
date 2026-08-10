'use strict'
/**
 * Tareas del CRM que EJECUTAN UN FLUJO al vencer.
 *
 * Hasta ahora una tarea solo avisaba a la persona asignada (services/emailNotify.js). Con el
 * tipo `flujo`, la tarea deja de ser un recordatorio para alguien y pasa a ser una acción
 * programada: al llegar su fecha, se ejecuta el flujo elegido sobre la conversación del
 * contacto de la tarea.
 *
 * El flujo va en su propia columna (`flow_id`) y no dentro de `refs`, porque `refs` ya guarda
 * un ARRAY de chats referenciados.
 *
 * Reutiliza `executeFlow` tal cual, igual que hacen los recontactos en modo flujo.
 */
const pool = require('../db')
const store = require('../flow/store')
const { executeFlow } = require('../flow/engine')
const { buildOutbound } = require('./calendarNotify')

const TASK_TYPE = 'flujo'
const SCAN_LIMIT = 50
const MAX_INTENTOS = 3          // tras esto se deja de reintentar y se anota el motivo
const EXTERNAL_CHANNELS = new Set(['whatsapp', 'messenger', 'instagram'])
const CONV_COLS = 'id, agent_id, channel_type, channel_id, wa_from, messenger_from, ig_from'

/**
 * Conversación sobre la que correr el flujo.
 *
 * Una tarea puede colgar de un chat, de un contacto o de un ticket del pipeline, según dónde
 * se haya creado, así que hay que cubrir los tres casos. La vía del contacto es la misma que
 * usan los recordatorios de reserva (services/calendarNotify.js).
 */
async function resolveConvo(accId, targetType, targetId) {
  if (!targetId) return null
  const id = String(targetId)

  if (targetType === 'conversation') {
    const [[c]] = await pool.query(`SELECT ${CONV_COLS} FROM conversations WHERE id=? AND account_id=?`, [id, accId])
    return c || null
  }

  if (targetType === 'card') {
    // La tarjeta guarda a qué conversación está vinculada dentro del JSON del pipeline.
    const [pipes] = await pool.query('SELECT cards FROM pipelines WHERE account_id=?', [accId])
    for (const p of pipes) {
      let cards = []
      try { cards = typeof p.cards === 'string' ? JSON.parse(p.cards) : (p.cards || []) } catch { continue }
      const card = cards.find(c => c?.id === id)
      const convId = card?.convId || card?.conversationId
      if (!convId) continue
      const [[c]] = await pool.query(`SELECT ${CONV_COLS} FROM conversations WHERE id=? AND account_id=?`, [convId, accId])
      if (c) return c
    }
    return null
  }

  // Por defecto (y para `contact`): la conversación más reciente de ese contacto.
  const [[c]] = await pool.query(
    `SELECT ${CONV_COLS} FROM conversations WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars,'$.contact_id'))=? ORDER BY updated_at DESC LIMIT 1`,
    [accId, id]
  )
  return c || null
}

async function anotar(accId, targetType, targetId, titulo, detalle) {
  try {
    await pool.query(
      'INSERT INTO crm_activity (account_id, target_type, target_id, kind, title, detail, author_id, author_name, ts) VALUES (?,?,?,?,?,?,?,?,?)',
      [accId, targetType || 'contact', String(targetId || ''), 'task', titulo, detalle, null, 'Automático', Date.now()]
    )
  } catch { /* la anotación no debe tumbar la ejecución */ }
}

async function cerrar(taskId, intentos, error = '') {
  await pool.query('UPDATE crm_tasks SET status=?, completed_at=?, flow_runs=?, flow_error=? WHERE id=?',
    ['done', Date.now(), intentos, error || null, taskId])
}

async function procesar(t) {
  const flowId = t.flow_id || ''
  const intentos = Number(t.flow_runs || 0)

  if (!flowId) {
    await cerrar(t.id, intentos, 'La tarea no tiene ningún flujo asignado.')
    await anotar(t.account_id, t.target_type, t.target_id, `Tarea "${t.title}" sin flujo`, 'La tarea era de tipo flujo pero no tenía ninguno elegido.')
    return
  }

  const conv = await resolveConvo(t.account_id, t.target_type, t.target_id)
  if (!conv) {
    // Sin conversación no hay a quién escribir. Se anota y se cierra: reintentar no ayuda.
    await cerrar(t.id, intentos, 'El contacto no tiene ninguna conversación.')
    await anotar(t.account_id, t.target_type, t.target_id, `No se pudo ejecutar "${t.title}"`, 'El contacto de la tarea no tiene ninguna conversación en la que ejecutar el flujo.')
    return
  }

  const account = await store.loadAccount(t.account_id)
  const agent = account?.agents?.find(a => a.id === conv.agent_id)
  // Canales de Meta: hay que entregar por su API, así que necesitan credenciales y destino.
  // Webchat y pruebas se persisten y llegan por socket, sin outbound.
  const outbound = (agent && EXTERNAL_CHANNELS.has(conv.channel_type))
    ? buildOutbound(agent, conv.channel_type, conv.channel_id, conv.wa_from || conv.messenger_from || conv.ig_from)
    : null

  try {
    await executeFlow({
      flowId, accId: t.account_id, agId: conv.agent_id, convId: conv.id,
      triggerContext: {
        tarea: true, motivo: 'tarea_programada', tarea_id: t.id, tarea_titulo: t.title || '',
        nota: t.description || '', message: t.description || '', _lastUserMessage: '',
      },
      outbound,
    })
    await cerrar(t.id, intentos + 1, '')
    await anotar(t.account_id, t.target_type, t.target_id, `Tarea "${t.title}" ejecutada`, 'Se ejecutó el flujo programado en la conversación del contacto.')
  } catch (e) {
    const n = intentos + 1
    if (n >= MAX_INTENTOS) {
      await cerrar(t.id, n, e.message)
      await anotar(t.account_id, t.target_type, t.target_id, `Falló la tarea "${t.title}"`, `El flujo falló ${n} veces. Último motivo: ${e.message}`)
    } else {
      // Se deja abierta para el siguiente pase, con la cuenta de intentos al día: así un
      // fallo pasajero no descarta la tarea, pero tampoco se reintenta para siempre.
      await pool.query('UPDATE crm_tasks SET flow_runs=?, flow_error=? WHERE id=?', [n, e.message, t.id])
      console.warn('[taskFlows]', t.id, `intento ${n}/${MAX_INTENTOS}:`, e.message)
    }
  }
}

async function tick() {
  try {
    const [rows] = await pool.query(
      "SELECT id, account_id, target_type, target_id, title, description, flow_id, flow_runs FROM crm_tasks WHERE status='open' AND type=? AND due_at IS NOT NULL AND due_at<=? ORDER BY due_at ASC LIMIT ?",
      [TASK_TYPE, Date.now(), SCAN_LIMIT]
    )
    for (const t of rows) {
      try { await procesar(t) } catch (e) { console.warn('[taskFlows tarea]', t.id, e.message) }
    }
  } catch (e) { console.warn('[taskFlows tick]', e.message) }
}

let _timer = null
const SCAN_MS = 60 * 1000
function startWorker() {
  if (_timer) return
  _timer = setInterval(() => tick().catch(() => {}), SCAN_MS)
  _timer.unref?.()
  setTimeout(() => tick().catch(() => {}), 20000)
}

module.exports = { tick, startWorker, TASK_TYPE }
