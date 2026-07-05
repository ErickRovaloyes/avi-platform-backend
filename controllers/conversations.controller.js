'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')
const {
  sendWhatsAppText, sendMessengerText, sendInstagramText,
} = require('../services/metaSend')

// Finds an existing contact for this conversation sender or creates one.
// Non-critical: errors are swallowed so conversation creation is never blocked.
async function findOrCreateContact(accId, { guestName, guestId, waFrom, messengerFrom, igFrom, channelType }) {
  try {
    let existing = null

    // WhatsApp: match by phone number
    if (channelType === 'whatsapp' && waFrom) {
      const [[row]] = await pool.query(
        'SELECT id FROM contacts WHERE account_id=? AND phone=?', [accId, waFrom]
      )
      existing = row
    }

    // Any channel: match by guestId stored in extra JSON
    if (!existing && guestId) {
      const [[row]] = await pool.query(
        `SELECT id FROM contacts WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(extra, '$.guestId'))=?`,
        [accId, String(guestId)]
      )
      existing = row
    }

    if (existing) return existing.id

    const contactId = 'contact_' + uid()
    const extra = {
      guestId: guestId ? String(guestId) : '',
      channelType,
      ...(messengerFrom ? { messengerId: messengerFrom } : {}),
      ...(igFrom        ? { instagramId: igFrom }       : {}),
    }
    await pool.query(
      'INSERT INTO contacts (id,account_id,name,email,phone,extra,created_at) VALUES (?,?,?,?,?,?,?)',
      [contactId, accId, guestName || 'Visitante', '', waFrom || '', JSON.stringify(extra), Date.now()]
    )
    return contactId
  } catch (e) {
    console.error('[FIND_OR_CREATE_CONTACT]', e)
    return null
  }
}

const mapConvo = (c, messages = []) => ({
  id: c.id, guestName: c.guest_name, guestId: c.guest_id,
  channelId: c.channel_id, linkId: c.channel_id, channel: c.channel_type,
  waFrom: c.wa_from, messengerFrom: c.messenger_from, igFrom: c.ig_from,
  initials: c.initials, preview: c.preview,
  unread: !!c.unread, unreadCount: Number(c.unread_count) || 0, aiEnabled: !!c.ai_enabled,
  aiDisabledReason: c.ai_disabled_reason || null,
  archived: !!c.archived, blocked: !!c.blocked,
  origin:        parseJ(c.origin, null),
  labels:        parseJ(c.labels, []),
  pipelineCards: parseJ(c.pipeline_cards, []),
  localVars:     parseJ(c.local_vars, {}),
  debugLog:      parseJ(c.debug_log, []),
  assignedTo:    parseJ(c.assigned_to, null),
  messages,
  createdAt: c.created_at, updatedAt: c.updated_at,
})

const listConvos = async (req, res) => {
  const { accId, agId } = req.params
  try {
    // Sin ORDER BY en SQL: ordenar con SELECT * sobre columnas JSON (debug_log,
    // local_vars, metadata) provoca un filesort de filas anchas que revienta el
    // sort_buffer ("Out of sort memory") en MySQL 8. Se ordena en JS (barato).
    const [rows] = await pool.query('SELECT * FROM conversations WHERE account_id=? AND agent_id=?', [accId, agId])
    if (rows.length === 0) return res.json([])
    rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    const convIds = rows.map(c => c.id)
    const [msgs]  = await pool.query('SELECT * FROM messages WHERE conversation_id IN (?)', [convIds])
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const msgsByConv = {}
    for (const m of msgs) {
      if (!msgsByConv[m.conversation_id]) msgsByConv[m.conversation_id] = []
      msgsByConv[m.conversation_id].push({ id: m.id, sender: m.sender, content: m.content, ts: m.ts, ...parseJ(m.metadata, {}) })
    }
    res.json(rows.map(c => mapConvo(c, msgsByConv[c.id] || [])))
  } catch (err) {
    console.error('[GET CONVOS]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const getConvo = async (req, res) => {
  const { accId, agId, convId } = req.params
  try {
    const [[c]] = await pool.query('SELECT * FROM conversations WHERE id=? AND account_id=? AND agent_id=?', [convId, accId, agId])
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada' })
    const [msgs] = await pool.query('SELECT * FROM messages WHERE conversation_id=?', [convId])
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0))
    res.json(mapConvo(c, msgs.map(m => ({ id: m.id, sender: m.sender, content: m.content, ts: m.ts, ...parseJ(m.metadata, {}) }))))
  } catch (err) {
    console.error('[GET CONVO]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const createConvo = async (req, res) => {
  const { accId, agId } = req.params
  const { guestName, guestId, channelId, channelType = 'webchat', waFrom, messengerFrom, igFrom, origin } = req.body
  const id       = `conv_${Date.now()}_${guestId || uid()}`
  const initials = (guestName || '').slice(0, 2).toUpperCase()
  const ts       = Date.now()

  const contactId = await findOrCreateContact(accId, { guestName, guestId, waFrom, messengerFrom, igFrom, channelType })
  const localVars = { var_nombre: guestName || '' }
  if (contactId) {
    localVars.contact_id = contactId
    // Memoria permanente del cliente (de conversaciones pasadas) → la nueva
    // conversación arranca conociéndolo.
    try { const mem = await require('../services/conversationMemory').getContactMemory(accId, contactId); if (mem) localVars._summary = mem } catch {}
  }

  try {
    // Origen del lead: usa el que envía el cliente (webchat ya clasificado) o lo
    // deriva del link (channelId = id del Webchat Link) → tipo "link", si no "directo".
    const originObj = (origin && typeof origin === 'object')
      ? origin
      : { type: channelId ? 'link' : 'direct', linkId: channelId || null }
    await pool.query(
      `INSERT INTO conversations
       (id,account_id,agent_id,channel_id,channel_type,guest_name,guest_id,wa_from,messenger_from,ig_from,initials,preview,unread,ai_enabled,labels,pipeline_cards,local_vars,debug_log,origin,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, accId, agId, channelId, channelType, guestName, guestId,
       waFrom || null, messengerFrom || null, igFrom || null,
       initials, '', 0, 1, '[]', '[]', JSON.stringify(localVars), '[]', JSON.stringify(originObj), ts, ts]
    )
    try { require('../services/subscriptions').incrementConversation(accId) } catch {}
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ id })
  } catch (err) {
    console.error('[POST CONVO]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// ── Conversation patch (labels, AI toggle, pipeline cards, etc) ───────────────
// IMPORTANT: this does NOT bump `updated_at` — only a new incoming/outgoing message
// should move a conversation to the top of the list (WhatsApp-style stable order).
// `preview` only ever changes when a message is appended, so it's safe to ignore here.
const updateConvo = async (req, res) => {
  const { accId, agId, convId } = req.params
  try {
    const map = { guestName:'guest_name', preview:'preview', unread:'unread', aiEnabled:'ai_enabled', labels:'labels', pipelineCards:'pipeline_cards', localVars:'local_vars', debugLog:'debug_log', assignedTo:'assigned_to', origin:'origin', archived:'archived', blocked:'blocked' }
    const sets = []
    const vals = []
    for (const [key, col] of Object.entries(map)) {
      if (req.body[key] !== undefined) {
        sets.push(`${col}=?`)
        const v = req.body[key]
        vals.push(typeof v === 'object' ? JSON.stringify(v) : v)
      }
    }
    // La IA NO se puede reactivar en un chat que la Demo desactivó por el límite
    // de respuestas: solo se permite tras adquirir un plan de pago (la conversión
    // limpia el motivo). Mientras el motivo siga puesto, se ignora la reactivación.
    let aiLimitBlocked = false
    if (req.body.aiEnabled) {
      const [[cur]] = await pool.query('SELECT ai_disabled_reason FROM conversations WHERE id=? AND account_id=?', [convId, accId])
      if (cur?.ai_disabled_reason === 'ai_per_conv_limit') {
        aiLimitBlocked = true
        const i = sets.indexOf('ai_enabled=?')
        if (i !== -1) { sets.splice(i, 1); vals.splice(i, 1) } // no reactivar
      }
    }
    if (sets.length === 0) return res.json({ ok: true, aiLimitBlocked })
    vals.push(convId, accId)
    await pool.query(`UPDATE conversations SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'convos:updated', { accId, agId })

    // Notify the assignee (targeted) when a conversation gets assigned to
    // someone other than the person making the assignment.
    const assignee = req.body.assignedTo
    if (assignee && assignee.id && assignee.id !== req.user?.id) {
      const [[c]] = await pool.query('SELECT guest_name, preview FROM conversations WHERE id=? AND account_id=?', [convId, accId])
      socket.emitToMember(assignee.id, 'conv:assigned', {
        accId, agId, convId,
        guestName:  c?.guest_name || 'Conversación',
        preview:    c?.preview || '',
        assignedBy: req.user?.name || 'Un compañero',
      })
    }

    res.json({ ok: true, aiLimitBlocked })
  } catch (err) {
    console.error('[PUT CONVO]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// Elimina una conversación y sus mensajes/media asociados.
const deleteConvo = async (req, res) => {
  const { accId, agId, convId } = req.params
  try {
    await pool.query('DELETE FROM messages WHERE conversation_id=?', [convId]).catch(() => {})
    await pool.query('DELETE FROM media WHERE conversation_id=? AND account_id=?', [convId, accId]).catch(() => {})
    await pool.query('DELETE FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ ok: true })
  } catch (err) { console.error('[DELETE CONVO]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Marking as read MUST NOT reorder the list; just clear the unread flag.
const markRead = async (req, res) => {
  const { accId, agId, convId } = req.params
  try {
    await pool.query('UPDATE conversations SET unread=0, unread_count=0 WHERE id=? AND account_id=?', [convId, accId])
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Core reutilizable: inserta el mensaje, actualiza la conversación y emite los
// eventos socket. Usado por el handler HTTP y por el envío manual del asesor.
async function appendMessageCore(accId, agId, convId, body) {
  const { sender, content, ...rest } = body
  const id       = 'msg_' + uid()
  const ts       = Date.now()
  const metadata = Object.keys(rest).length ? rest : null
  await pool.query('INSERT INTO messages (id,conversation_id,sender,content,metadata,ts) VALUES (?,?,?,?,?,?)',
    [id, convId, sender, content, metadata ? JSON.stringify(metadata) : null, ts])
  const sets = ['preview=?', 'updated_at=?']
  const vals = [(content || '').slice(0, 60), ts]
  if (sender === 'user') sets.push('unread=1', 'unread_count=unread_count+1')
  vals.push(convId, accId)
  await pool.query(`UPDATE conversations SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)

  if (sender === 'user' && content) {
    try {
      const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
      const lv = parseJ(c?.local_vars, {})
      lv._lastUserMessage = content
      await pool.query('UPDATE conversations SET local_vars=? WHERE id=? AND account_id=?', [JSON.stringify(lv), convId, accId])
    } catch { /* non-critical */ }
  }

  const msg = { id, sender, content, ts, ...rest }
  socket.emit(accId, 'message:new', { accId, agId, convId, message: msg })
  socket.emitToConv(convId, 'message:new', { convId, message: msg })
  return { id, ts }
}

const appendMessage = async (req, res) => {
  const { accId, agId, convId } = req.params
  try {
    const out = await appendMessageCore(accId, agId, convId, req.body)
    res.json(out)
  } catch (err) {
    console.error('[POST MSG]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// Resuelve la config del canal de un agente (por id, o por tipo si no hay id).
// La config de cada canal vive dentro del JSON `channels` de la tabla agents.
async function resolveChannelConfig(accId, agId, channelType, channelId) {
  const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
  const channels = parseJ(ag?.channels, [])
  const ofType = channels.filter(c => c.type === channelType)
  const chosen = (channelId && ofType.find(c => c.id === channelId))
    || ofType.find(c => c.status === 'connected')
    || ofType[0]
  return chosen || null
}

// Envío MANUAL del asesor: entrega el texto al canal real (WhatsApp/Messenger/IG)
// y lo persiste en la conversación. En webchat solo persiste (el visitante lo
// recibe por socket). Esto arregla que las respuestas manuales no llegaban.
const sendManual = async (req, res) => {
  const { accId, agId, convId } = req.params
  const { text, senderName, replyToId } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Texto vacío' })
  try {
    const [[conv]] = await pool.query(
      'SELECT channel_type, channel_id, wa_from, messenger_from, ig_from FROM conversations WHERE id=? AND account_id=?',
      [convId, accId]
    )
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' })
    const type = conv.channel_type

    // ¿El asesor está respondiendo (citando) un mensaje? Resolvemos el mensaje
    // citado: su wamid (para la cita nativa de WhatsApp) y su contenido (para
    // mostrar la cita en la bandeja).
    let replyTo = null, quotedWamid = null
    if (replyToId) {
      const [[qm]] = await pool.query('SELECT id, sender, content, metadata FROM messages WHERE id=? AND conversation_id=?', [replyToId, convId])
      if (qm) {
        const meta = parseJ(qm.metadata, {})
        let content = qm.content || ''
        if (!content && meta.kind) content = `[${meta.kind}${meta.filename ? ': ' + meta.filename : ''}]`
        replyTo = { id: qm.id, content, sender: qm.sender, kind: meta.kind || null, filename: meta.filename || null }
        quotedWamid = meta.waMessageId || null
      }
    }

    // Ventana de servicio de 24h de WhatsApp: se reinicia con cada mensaje
    // entrante del cliente. Fuera de ella la API de Meta rechaza el texto libre,
    // así que el asesor solo puede enviar una plantilla aprobada o un flujo.
    if (type === 'whatsapp') {
      const [[lastIn]] = await pool.query(
        "SELECT MAX(ts) AS ts FROM messages WHERE conversation_id=? AND sender='user'", [convId]
      )
      const lastTs = Number(lastIn?.ts) || 0
      if (!lastTs || (Date.now() - lastTs) >= 24 * 3600 * 1000) {
        return res.status(409).json({
          error: 'La ventana de 24 h de WhatsApp está cerrada. Solo puedes enviar una plantilla aprobada o ejecutar un flujo.',
          code: 'wa_window_closed',
        })
      }
    }

    let providerMsgId = null
    let status = null

    // Entrega al canal externo si corresponde
    try {
      if (type === 'whatsapp' && conv.wa_from) {
        const ch = await resolveChannelConfig(accId, agId, 'whatsapp', conv.channel_id)
        const cfg = ch?.config || {}
        if (!cfg.phoneNumberId || !cfg.accessToken) return res.status(400).json({ error: 'Canal WhatsApp sin configurar' })
        const r = await sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: conv.wa_from, text, contextMessageId: quotedWamid })
        providerMsgId = r?.messages?.[0]?.id || null; status = 'sent'
      } else if (type === 'messenger' && conv.messenger_from) {
        const ch = await resolveChannelConfig(accId, agId, 'messenger', conv.channel_id)
        const cfg = ch?.config || {}
        if (!cfg.pageId || !cfg.pageAccessToken) return res.status(400).json({ error: 'Canal Messenger sin configurar' })
        const r = await sendMessengerText({ pageId: cfg.pageId, pageAccessToken: cfg.pageAccessToken, recipientId: conv.messenger_from, text })
        providerMsgId = r?.message_id || null; status = 'sent'
      } else if (type === 'instagram' && conv.ig_from) {
        const ch = await resolveChannelConfig(accId, agId, 'instagram', conv.channel_id)
        const cfg = ch?.config || {}
        if (!cfg.igAccountId || !cfg.pageAccessToken) return res.status(400).json({ error: 'Canal Instagram sin configurar' })
        const r = await sendInstagramText({ igAccountId: cfg.igAccountId, pageAccessToken: cfg.pageAccessToken, recipientId: conv.ig_from, text })
        providerMsgId = r?.message_id || null; status = 'sent'
      }
      // webchat / test: no hay envío externo; solo se persiste
    } catch (e) {
      return res.status(502).json({ error: e.message || 'No se pudo entregar el mensaje al canal' })
    }

    const out = await appendMessageCore(accId, agId, convId, {
      role: 'assistant', sender: 'human',
      senderName: senderName || req.user?.name || 'Asesor',
      content: String(text), channel: type, channelId: conv.channel_id,
      ...(replyTo ? { replyTo } : {}),
      ...(providerMsgId ? { waMessageId: providerMsgId } : {}),
      ...(status ? { status } : {}),
    })
    res.json({ ok: true, ...out })
  } catch (err) {
    console.error('[SEND MANUAL]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const appendDebug = async (req, res) => {
  const { accId, agId, convId } = req.params
  const entry = { ...req.body, ts: Date.now() }
  try {
    const [[c]] = await pool.query('SELECT debug_log FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    const log = parseJ(c?.debug_log, [])
    log.push(entry)
    await pool.query('UPDATE conversations SET debug_log=? WHERE id=? AND account_id=?', [JSON.stringify(log), convId, accId])

    // Registro de errores global: los flujos que corren en el NAVEGADOR (pruebas
    // y webchat) reportan sus errores por este endpoint. Sin esto, solo aparecían
    // los errores de canales reales (que corren en el backend). El JOIN con la
    // conversación da la referencia del chat (guest + canal) en la vista.
    if (entry?.type === 'error') {
      try {
        const detail = entry.detail != null
          ? (typeof entry.detail === 'object' ? JSON.stringify(entry.detail) : String(entry.detail))
          : null
        await pool.query(
          'INSERT INTO error_log (account_id, agent_id, conv_id, source, message, detail, ts) VALUES (?,?,?,?,?,?,?)',
          [accId, agId || null, convId || null, 'flow', String(entry.title || '').slice(0, 500), detail ? detail.slice(0, 1000) : null, Date.now()]
        )
      } catch (e) { /* non-critical */ }
    }
    res.json({ ok: true })
  } catch (err) { console.error('[DEBUG]', err); res.status(500).json({ error: 'Error interno' }) }
}

const patchVars = async (req, res) => {
  const { accId, agId, convId } = req.params
  const { varId, value } = req.body
  try {
    const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada' })
    const vars = parseJ(c.local_vars, {})
    vars[varId] = value
    // Local var changes don't reorder the chat list — only new messages do.
    await pool.query('UPDATE conversations SET local_vars=? WHERE id=?', [JSON.stringify(vars), convId])
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Guest counter ─────────────────────────────────────────────────────────────

const getGuest = async (req, res) => {
  try {
    await pool.query('UPDATE counters SET value=value+1 WHERE name="guest_counter"')
    const [[ctr]] = await pool.query('SELECT value FROM counters WHERE name="guest_counter"')
    const n = ctr?.value || 1001
    res.json({ name: `Invitado #${n}`, id: String(n) })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Social create-or-get ──────────────────────────────────────────────────────

async function createOrGetSocialConvo(accId, agId, lookupCol, lookupVal, guestName, channelType, channelId, origin = null) {
  const [[existing]] = await pool.query(
    `SELECT id FROM conversations WHERE account_id=? AND agent_id=? AND ${lookupCol}=?`,
    [accId, agId, lookupVal]
  )
  if (existing) return existing.id
  await pool.query('UPDATE counters SET value=value+1 WHERE name="guest_counter"')
  const [[ctr]] = await pool.query('SELECT value FROM counters WHERE name="guest_counter"')
  const n  = ctr?.value || Date.now()
  const id = `conv_${channelType}_${Date.now()}_${n}`
  const ts = Date.now()

  const contactArgs = { guestName, guestId: String(n), channelType }
  if (lookupCol === 'wa_from')        contactArgs.waFrom        = lookupVal
  else if (lookupCol === 'messenger_from') contactArgs.messengerFrom = lookupVal
  else if (lookupCol === 'ig_from')   contactArgs.igFrom        = lookupVal
  const contactId = await findOrCreateContact(accId, contactArgs)
  const localVars = { var_nombre: guestName || '' }
  if (contactId) {
    localVars.contact_id = contactId
    try { const mem = await require('../services/conversationMemory').getContactMemory(accId, contactId); if (mem) localVars._summary = mem } catch {}
  }

  const cols = {
    id, account_id: accId, agent_id: agId,
    channel_id: channelId || channelType, channel_type: channelType,
    guest_name: guestName, guest_id: String(n),
    initials: (guestName || '').slice(0, 2).toUpperCase(),
    preview: '', unread: 1, ai_enabled: 1,
    labels: '[]', pipeline_cards: '[]',
    local_vars: JSON.stringify(localVars),
    debug_log: '[]',
    origin: JSON.stringify(origin || { type: channelId ? 'link' : 'direct', linkId: channelId || null }),
    created_at: ts, updated_at: ts,
  }
  cols[lookupCol] = lookupVal
  const keys = Object.keys(cols); const vals = Object.values(cols)
  await pool.query(`INSERT INTO conversations (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, vals)
  // Suma 1 al consumo de conversaciones de la suscripción (límites demo/mensuales).
  try { require('../services/subscriptions').incrementConversation(accId) } catch {}
  return id
}

const createWhatsApp = async (req, res) => {
  const { accId, agId } = req.params
  const { waFrom, waName, channelId } = req.body
  try {
    const convId = await createOrGetSocialConvo(accId, agId, 'wa_from', waFrom, waName || `WA #${(waFrom || '').slice(-4)}`, 'whatsapp', channelId)
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ id: convId, convId })
  } catch (err) {
    console.error('[WA CONVO]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const createMessenger = async (req, res) => {
  const { accId, agId } = req.params
  const { senderId, senderName, channelId } = req.body
  try {
    const convId = await createOrGetSocialConvo(accId, agId, 'messenger_from', senderId, senderName || `FB #${(senderId || '').slice(-4)}`, 'messenger', channelId)
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ id: convId, convId })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createInstagram = async (req, res) => {
  const { accId, agId } = req.params
  const { senderId, senderName, channelId } = req.body
  try {
    const convId = await createOrGetSocialConvo(accId, agId, 'ig_from', senderId, senderName || `IG #${(senderId || '').slice(-4)}`, 'instagram', channelId)
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ id: convId, convId })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createSocial = async (req, res) => {
  const { accId, agId } = req.params
  const { type, from, name, channelId } = req.body
  try {
    const lookup = type === 'whatsapp' ? 'wa_from' : type === 'messenger' ? 'messenger_from' : 'ig_from'
    const convId = await createOrGetSocialConvo(accId, agId, lookup, from, name || `${type} #${(from || '').slice(-4)}`, type, channelId)
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ id: convId })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Actualiza la MEMORIA persistente de la conversación (resumen + estado). Lo
// llama el webchat-en-navegador tras cada respuesta del asistente. Responde de
// inmediato y resume en segundo plano (no bloquea el chat).
const updateMemory = async (req, res) => {
  const { accId, agId, convId } = req.params
  res.json({ ok: true })
  try { require('../services/conversationMemory').updateMemory(accId, agId, convId).catch(() => {}) } catch {}
}

module.exports = {
  listConvos, getConvo, createConvo, updateConvo, deleteConvo, markRead,
  appendMessage, sendManual, appendDebug, patchVars, getGuest, updateMemory,
  createWhatsApp, createMessenger, createInstagram, createSocial,
  // Reusable cores for the server-side flow engine
  createOrGetSocialConvo,
}
