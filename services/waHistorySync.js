'use strict'
/**
 * Sincronización de historial de Coexistencia de WhatsApp.
 *
 * Cuando un negocio conecta su número por Coexistencia, Meta envía (una sola vez,
 * durante el onboarding) hasta 6 meses de historial y, de forma continua, ecos de
 * lo que el negocio manda desde el celular y sincronización de contactos. Estos
 * llegan por webhook con `change.field`:
 *   · `history`               → mensajes previos (cliente + negocio) por hilo
 *   · `smb_message_echoes`    → mensajes que el negocio envió desde la app del móvil
 *   · `smb_app_state_sync`    → alta/cambios de contactos de la agenda
 *
 * Aquí se hace BACKFILL idempotente: se crean/localizan las conversaciones y se
 * insertan los mensajes con su timestamp ORIGINAL, SIN correr la IA ni enviar nada
 * (sería un desastre que el bot respondiera a chats viejos). Marca las
 * conversaciones como de "cliente recurrente" para que el asistente retome el hilo.
 *
 * La forma exacta de los payloads de coexistencia puede variar; el parser es
 * defensivo (varios nombres de campo posibles) y nunca lanza.
 */
const pool = require('../db')
const socket = require('./socket')
const { uid, parseJ } = require('../utils')
const store = require('../flow/store')

const digits = s => String(s || '').replace(/\D/g, '')

// Texto legible de un mensaje de WhatsApp (para backfill guardamos texto/caption;
// los medios se representan con una etiqueta para no descargar miles de archivos).
function extractText(m) {
  if (m?.text?.body) return m.text.body
  const cap = m?.image?.caption || m?.video?.caption || m?.document?.caption
  if (cap) return cap
  switch (m?.type) {
    case 'image':    return '[imagen]'
    case 'video':    return '[video]'
    case 'audio':    return '[audio]'
    case 'sticker':  return '[sticker]'
    case 'location': return '[ubicación]'
    case 'contacts': return '[contacto]'
    case 'document': return `[documento${m.document?.filename ? ': ' + m.document.filename : ''}]`
    default:         return m?.button?.text || m?.interactive?.list_reply?.title || `[${m?.type || 'mensaje'}]`
  }
}

// Inserta un mensaje histórico directo (sin appendMsg: preserva el ts original,
// no marca no-leído ni emite sockets por-mensaje).
async function insertHistorical(convId, { sender, content, ts, waMessageId }) {
  const id = 'msg_' + uid()
  const metadata = JSON.stringify({ waMessageId, historical: true })
  await pool.query(
    'INSERT INTO messages (id,conversation_id,sender,content,metadata,ts) VALUES (?,?,?,?,?,?)',
    [id, convId, sender, content || '', metadata, ts]
  )
}

// Backfill de un grupo de mensajes pertenecientes a UN cliente (hilo).
async function backfillThread(accId, agentId, customerWaId, customerName, messages, forceOutbound) {
  const custId = digits(customerWaId)
  if (!custId || !Array.isArray(messages) || !messages.length) return null
  const convId = await store.createOrGetWhatsAppConvo(accId, agentId, custId, customerName || '', null, { type: 'wa_history' })
  if (!convId) return null

  const ordered = [...messages].sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0))
  let inserted = 0, maxTs = 0, lastText = ''
  for (const m of ordered) {
    const waId = m?.id
    if (!waId) continue
    try {
      if (await store.messageExistsByProviderId(convId, waId)) continue
      const ts = (Number(m.timestamp) || 0) * 1000 || Date.now()
      // Dirección: si el `from` es el propio cliente → entrante (user); si es el
      // negocio (o es un eco) → saliente, lo tratamos como enviado por un humano.
      const inbound = !forceOutbound && (!m.from || digits(m.from) === custId)
      const sender = inbound ? 'user' : 'human'
      const content = extractText(m)
      await insertHistorical(convId, { sender, content, ts, waMessageId: waId })
      inserted++
      if (ts >= maxTs) { maxTs = ts; lastText = content }
    } catch (e) { console.warn('[waHistorySync insert]', e.message) }
  }
  if (!inserted) return null
  return { convId, maxTs, lastText }
}

// Ajusta la conversación tras el backfill: marca recurrente, sincroniza preview/
// updated_at con el mensaje más reciente REAL y evita ruido de "no leído".
async function finalizeConv(accId, convId, fallback) {
  try {
    const [[latest]] = await pool.query('SELECT content, ts FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 1', [convId])
    await pool.query(
      `UPDATE conversations
         SET returning_contact=1, unread=0, unread_count=0,
             local_vars=JSON_SET(COALESCE(local_vars,'{}'), '$._returning', true),
             preview=?, updated_at=?
       WHERE id=? AND account_id=?`,
      [String(latest?.content || fallback?.lastText || '').slice(0, 60), Number(latest?.ts || fallback?.maxTs) || Date.now(), convId, accId]
    )
  } catch (e) { console.warn('[waHistorySync finalize]', e.message) }
}

// ── smb_app_state_sync: alta/actualización de contactos de la agenda ────────────
async function ingestContactSync(accId, value) {
  const items = value?.state_sync || value?.contacts || value?.contact || []
  const list = Array.isArray(items) ? items : [items]
  let n = 0
  for (const it of list) {
    try {
      const c = it?.contact || it || {}
      const phone = digits(c.phone_number || c.wa_id || c.phone)
      const name = (c.full_name || c.name || c.profile?.name || '').trim()
      const action = (it?.action || 'add').toLowerCase()
      if (!phone || action === 'remove' || action === 'delete') continue
      const [[ex]] = await pool.query('SELECT id, name FROM contacts WHERE account_id=? AND phone=?', [accId, phone])
      if (ex) {
        if (name && (!ex.name || ex.name === 'Visitante')) await pool.query('UPDATE contacts SET name=? WHERE id=?', [name, ex.id])
      } else {
        await pool.query(
          'INSERT INTO contacts (id,account_id,name,email,phone,extra,created_at) VALUES (?,?,?,?,?,?,?)',
          ['contact_' + uid(), accId, name || phone, '', phone, JSON.stringify({ channelType: 'whatsapp', source: 'coexistence_sync' }), Date.now()]
        )
      }
      n++
    } catch (e) { console.warn('[waHistorySync contactSync]', e.message) }
  }
  if (n) console.log(`[waHistorySync] ${accId}: ${n} contacto(s) sincronizado(s)`)
}

// ── Punto de entrada: enruta el `field` de coexistencia ─────────────────────────
async function ingestCoexistenceChange(accId, agentId, field, value) {
  try {
    if (field === 'smb_app_state_sync') return await ingestContactSync(accId, value)

    // history / smb_message_echoes → mensajes a backfillear
    const groups = []   // { customerWaId, name, messages, forceOutbound }
    if (field === 'history') {
      // Estructura REAL de Meta (coexistencia): value.history[] → cada elemento
      // { metadata:{phase,chunk_order,progress}, threads[] }; cada thread
      // { id: <teléfono del cliente>, messages[] }. La dirección de cada mensaje la
      // resuelve backfillThread comparando `from` con el id del hilo (from == cliente
      // → entrante 'user'; from == negocio → saliente 'human').
      const hist = value?.history || []
      let nThreads = 0, nMsgs = 0
      for (const chunk of (Array.isArray(hist) ? hist : [hist])) {
        for (const thread of (chunk?.threads || [])) {
          const customerWaId = thread?.id || ''
          const messages = thread?.messages || []
          if (customerWaId && messages.length) { groups.push({ customerWaId, name: '', messages, forceOutbound: false }); nThreads++; nMsgs += messages.length }
        }
      }
      console.log(`[waHistorySync] ${accId}: history → ${nThreads} hilo(s), ${nMsgs} mensaje(s)`)
    } else if (field === 'smb_message_echoes') {
      // Ecos = salientes del negocio; agrupa por destinatario (el cliente).
      const echoes = value?.message_echoes || value?.messages || []
      const byCustomer = {}
      for (const m of (Array.isArray(echoes) ? echoes : [echoes])) {
        const cust = m?.to || m?.recipient_id || ''
        if (!cust) continue
        ;(byCustomer[cust] ||= []).push(m)
      }
      for (const [customerWaId, messages] of Object.entries(byCustomer)) {
        groups.push({ customerWaId, name: '', messages, forceOutbound: true })
      }
    } else {
      console.warn('[waHistorySync] campo de coexistencia no manejado:', field)
      return
    }

    const touched = []
    for (const g of groups) {
      const r = await backfillThread(accId, agentId, g.customerWaId, g.name, g.messages, g.forceOutbound)
      if (r) touched.push(r)
    }
    for (const t of touched) await finalizeConv(accId, t.convId, t)
    if (touched.length) {
      console.log(`[waHistorySync] ${accId}: ${field} → ${touched.length} conversación(es) actualizada(s)`)
      socket.emit(accId, 'convos:updated', { accId, agId: agentId })
    }
  } catch (e) {
    console.error('[waHistorySync ingest]', field, e.message)
  }
}

module.exports = { ingestCoexistenceChange }
