'use strict'
/**
 * Mensajería de los portales (Airbnb, Booking…) a través de Octorate.
 *
 * Octorate ya centraliza los mensajes de los huéspedes de cada portal. Aquí se convierten en
 * conversaciones normales de la plataforma, de modo que entran al inbox, las ve el asistente y
 * se responden como cualquier otro canal.
 *
 * El texto del mensaje NO viene en un campo suelto: Octorate lo manda en `attributes`, una lista
 * de pares `{ type, value }` donde el texto es el de tipo `TEXT`. Y `processor` dice de dónde
 * viene: `CHANNEL` es el portal (Airbnb/Booking), `DIRECT` el motor propio, y `NOTE` una nota
 * interna que NO debe llegarle al huésped.
 */
const pool = require('../db')
const oct = require('./octorate')
const store = require('../flow/store')

const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v])

/** El texto de un mensaje de Octorate. */
function textoDe(msg) {
  const attrs = arr(msg?.attributes)
  const t = attrs.find(a => String(a?.type).toUpperCase() === 'TEXT')
  if (t?.value) return String(t.value)
  // Sin texto puede ser una foto o un adjunto: se deja constancia en vez de una burbuja vacía.
  const otro = attrs.find(a => a?.value)
  return otro ? `[${String(otro.type || 'adjunto').toLowerCase()}]` : ''
}

/** Las notas internas del hotel no son mensajes del huésped y no deben entrar al inbox. */
const esDelHuesped = msg => String(msg?.processor || '').toUpperCase() !== 'NOTE'

/** De qué portal viene, para etiquetar la conversación. */
function portalDe(hilo, msg) {
  const ext = arr(hilo?.chatThreadExternals)[0]
  const p = String(ext?.portal || msg?.portal || '').toUpperCase()
  if (p.includes('AIRBNB')) return 'Airbnb'
  if (p.includes('BOOKING')) return 'Booking'
  return p || 'Portal'
}

/**
 * Busca o crea la conversación de un hilo de Octorate.
 *
 * El hilo se guarda en `local_vars._octorateThread`: es lo que permite que la respuesta del
 * asesor vuelva al portal correcto, y que un segundo mensaje del mismo huésped caiga en la
 * misma conversación en vez de abrir una nueva cada vez.
 */
async function conversacionDe(accId, agId, hilo, portal) {
  const hiloId = String(hilo?.id ?? hilo)
  const [[ya]] = await pool.query(
    `SELECT id FROM conversations
      WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(local_vars,'$._octorateThread'))=?
      LIMIT 1`,
    [accId, hiloId]
  ).catch(() => [[]])
  if (ya?.id) return ya.id

  const persona = arr(hilo?.persons)[0] || {}
  const nombre = persona.name || persona.externalGuest || `Huésped ${portal}`
  const convId = await store.createOrGetWhatsAppConvo?.(accId, agId, `octorate_${hiloId}`, nombre, null, { type: 'octorate', portal })
    .catch(() => null)
  if (convId) {
    await store.setLocalVar(accId, agId, convId, '_octorateThread', hiloId).catch(() => {})
    await store.setLocalVar(accId, agId, convId, '_octoratePortal', portal).catch(() => {})
  }
  return convId
}

/**
 * Llega un aviso `CHAT_MESSAGE_RECEIVED`.
 *
 * El aviso trae el identificador, no el contenido, así que hay que ir a buscar el mensaje. Se
 * hace de forma tolerante: un mensaje que no se pueda resolver se registra y no tumba el resto.
 */
async function entraMensaje(accId, cfg, aviso) {
  const prop = String(aviso?.property || aviso?.accommodation || cfg?.propertyId || '')
  const hiloId = aviso?.threadId || aviso?.thread || aviso?.chatThreadId
  if (!prop || !hiloId) { console.warn('[octorate chat] aviso sin propiedad o hilo'); return }

  const agId = cfg?.agentId || (await primerAgente(accId))
  if (!agId) { console.warn('[octorate chat] la cuenta no tiene agente'); return }

  let hilo = null, mensajes = []
  try {
    const hilos = arr(await oct.listarHilos(accId, cfg, prop, { }))
    hilo = hilos.find(h => String(h.id) === String(hiloId)) || { id: hiloId }
    mensajes = arr(await oct.mensajesDelHilo(accId, cfg, prop, hiloId, {}))
  } catch (e) { console.warn('[octorate chat] no se pudo leer el hilo:', e.message); return }

  const portal = portalDe(hilo, mensajes[0])
  const convId = await conversacionDe(accId, agId, hilo, portal)
  if (!convId) { console.warn('[octorate chat] no se pudo crear la conversacion'); return }

  // Solo lo nuevo: el aviso puede repetirse y el hilo trae todo su histórico.
  const [ultimos] = await pool.query(
    "SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.octorateMsgId')) AS ext FROM messages WHERE conversation_id=?",
    [convId]
  ).catch(() => [[]])
  const vistos = new Set((ultimos || []).map(r => String(r.ext)).filter(Boolean))

  for (const m of mensajes) {
    const ext = String(m?.externalId || m?.id || '')
    if (!ext || vistos.has(ext)) continue
    if (!esDelHuesped(m)) continue
    const texto = textoDe(m)
    if (!texto) continue
    await store.appendMsg(accId, agId, convId, {
      sender: 'user',
      content: texto,
      octorateMsgId: ext,
      channel: 'octorate',
      portal,
    }).catch(e => console.warn('[octorate chat] no se pudo guardar:', e.message))
  }
}

async function primerAgente(accId) {
  const [[a]] = await pool.query('SELECT id FROM agents WHERE account_id=? ORDER BY created_at LIMIT 1', [accId]).catch(() => [[]])
  return a?.id || null
}

/**
 * Envía una respuesta al portal.
 *
 * Se llama desde el envío manual del asesor y desde el motor cuando la conversación es de
 * Octorate. Si el hilo no está en las variables, no hay a dónde responder.
 */
async function responder(accId, cfg, convId, texto) {
  const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
  const lv = (() => { try { return typeof c?.local_vars === 'string' ? JSON.parse(c.local_vars) : (c?.local_vars || {}) } catch { return {} } })()
  const hiloId = lv._octorateThread
  if (!hiloId) throw new Error('Esta conversación no tiene un hilo de Octorate asociado.')
  const prop = String(cfg?.propertyId || '')
  if (!prop) throw new Error('Octorate: falta la propiedad configurada.')

  return oct.enviarMensaje(accId, cfg, prop, {
    threadId: Number(hiloId) || hiloId,
    processor: 'CHANNEL',
    attributes: [{ type: 'TEXT', value: String(texto) }],
  })
}

module.exports = { entraMensaje, responder, textoDe, esDelHuesped, portalDe }
