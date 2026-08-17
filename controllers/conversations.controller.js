'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')
const {
  sendWhatsAppText, sendMessengerText, sendInstagramText,
} = require('../services/metaSend')

// Finds an existing contact for this conversation sender or creates one.
// Devuelve { id, existed, hasMemory }: `existed`=el contacto ya estaba en la BD
// (mismo teléfono/guestId) y `hasMemory`=tiene memoria de conversaciones pasadas.
// Ambos sirven para marcar la conversación como de "cliente recurrente".
// Non-critical: errors are swallowed so conversation creation is never blocked.
async function findOrCreateContact(accId, { guestName, guestId, waFrom, messengerFrom, igFrom, channelType, origin }) {
  try {
    let existing = null

    // WhatsApp: match by phone number
    if (channelType === 'whatsapp' && waFrom) {
      const [[row]] = await pool.query(
        'SELECT id, memory FROM contacts WHERE account_id=? AND phone=?', [accId, waFrom]
      )
      existing = row
    }

    // Messenger / Instagram: emparejar por SU identificador, que es lo único estable. Se
    // guardaba en `extra` desde el principio pero nunca se buscaba, así que la misma persona
    // acababa con un contacto nuevo cada vez que se recreaba su conversación.
    if (!existing && (messengerFrom || igFrom)) {
      const campo = messengerFrom ? 'messengerId' : 'instagramId'
      const valor = messengerFrom || igFrom
      const [[row]] = await pool.query(
        `SELECT id, memory FROM contacts WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(extra, '$.${campo}'))=?`,
        [accId, String(valor)]
      )
      existing = row
    }

    // Any channel: match by guestId stored in extra JSON
    if (!existing && guestId) {
      const [[row]] = await pool.query(
        `SELECT id, memory FROM contacts WHERE account_id=? AND JSON_UNQUOTE(JSON_EXTRACT(extra, '$.guestId'))=?`,
        [accId, String(guestId)]
      )
      existing = row
    }

    if (existing) return { id: existing.id, existed: true, hasMemory: !!(existing.memory && String(existing.memory).trim()) }

    const contactId = 'contact_' + uid()
    const extra = {
      guestId: guestId ? String(guestId) : '',
      channelType,
      ...(messengerFrom ? { messengerId: messengerFrom } : {}),
      ...(igFrom        ? { instagramId: igFrom }       : {}),
      // Origen del lead al primer contacto (directo/anuncio/link/campaña) → para
      // clasificar y filtrar contactos por dónde llegaron.
      ...(origin?.type ? { originType: origin.type, origin } : {}),
    }
    await pool.query(
      'INSERT INTO contacts (id,account_id,name,email,phone,extra,created_at) VALUES (?,?,?,?,?,?,?)',
      [contactId, accId, guestName || 'Visitante', '', waFrom || '', JSON.stringify(extra), Date.now()]
    )
    return { id: contactId, existed: false, hasMemory: false }
  } catch (e) {
    console.error('[FIND_OR_CREATE_CONTACT]', e)
    return { id: null, existed: false, hasMemory: false }
  }
}

const mapConvo = (c, messages = []) => ({
  id: c.id, guestName: c.guest_name, guestId: c.guest_id,
  channelId: c.channel_id, linkId: c.channel_id, channel: c.channel_type,
  waFrom: c.wa_from, messengerFrom: c.messenger_from, igFrom: c.ig_from,
  initials: c.initials, preview: c.preview,
  unread: !!c.unread, unreadCount: Number(c.unread_count) || 0, aiEnabled: !!c.ai_enabled,
  aiDisabledReason: c.ai_disabled_reason || null,
  archived: !!c.archived, blocked: !!c.blocked, followup: !!c.followup,
  returning: !!c.returning_contact,
  topic: c.topic || null, sentiment: c.sentiment || null,
  buyingIntent: c.buying_intent || null, outcome: c.outcome || null,
  origin:        parseJ(c.origin, null),
  labels:        parseJ(c.labels, []),
  pipelineCards: parseJ(c.pipeline_cards, []),
  localVars:     parseJ(c.local_vars, {}),
  debugLog:      parseJ(c.debug_log, []),
  assignedTo:    parseJ(c.assigned_to, null),
  teamId:        c.team_id || null,
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
      msgsByConv[m.conversation_id].push({ id: m.id, sender: m.sender, content: m.content, ts: m.ts, starred: !!m.starred, ...parseJ(m.metadata, {}) })
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
    res.json(mapConvo(c, msgs.map(m => ({ id: m.id, sender: m.sender, content: m.content, ts: m.ts, starred: !!m.starred, ...parseJ(m.metadata, {}) }))))
  } catch (err) {
    console.error('[GET CONVO]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// Etiqueta (por nombre) para el reparto IA/Humano: la busca o la crea. Devuelve su id.
async function ensureLabel(accId, name, color) {
  try {
    const [[l]] = await pool.query('SELECT id FROM labels WHERE account_id=? AND name=? LIMIT 1', [accId, name])
    if (l) return l.id
    const id = 'lbl_' + uid()
    await pool.query('INSERT INTO labels (id,account_id,name,color) VALUES (?,?,?,?)', [id, accId, name, color])
    return id
  } catch { return null }
}

// Decide si una conversación NUEVA arranca con la IA activa o en manos de un humano,
// según el reparto por % configurado en el agente (round-robin determinista). Devuelve
// { aiEnabled:0|1, labelIds:[] }. Sin reparto activo → IA activa, sin etiqueta.
async function routeNewConversation(accId, agId) {
  try {
    const [[ag]] = await pool.query('SELECT routing, rr_ai, rr_total FROM agents WHERE id=? AND account_id=?', [agId, accId])
    const r = parseJ(ag?.routing, null)
    if (!ag || !r || !r.enabled) return { aiEnabled: 1, labelIds: [] }
    const pct = Math.max(0, Math.min(100, parseInt(r.aiPercent) || 0))
    const rrAi = Number(ag.rr_ai) || 0, rrTot = Number(ag.rr_total) || 0
    // Apportionment por redondeo: mantiene aiCount ≈ round(total * pct/100) e interleava.
    const assignAI = Math.round((rrTot + 1) * pct / 100) > rrAi
    if (assignAI) await pool.query('UPDATE agents SET rr_ai=rr_ai+1, rr_total=rr_total+1 WHERE id=?', [agId])
    else          await pool.query('UPDATE agents SET rr_total=rr_total+1 WHERE id=?', [agId])
    const labelId = await ensureLabel(accId, assignAI ? '🤖 IA' : '👤 Humano', assignAI ? '#7c6fff' : '#f5a623')
    return { aiEnabled: assignAI ? 1 : 0, labelIds: labelId ? [labelId] : [] }
  } catch { return { aiEnabled: 1, labelIds: [] } }
}

const createConvo = async (req, res) => {
  const { accId, agId } = req.params
  const { guestName, guestId, channelId, channelType = 'webchat', waFrom, messengerFrom, igFrom, origin } = req.body

  // Dominios autorizados del canal de webchat.
  //
  // El fragmento del widget queda a la vista en el HTML de la web del cliente, así que
  // cualquiera puede copiarlo a otro sitio — y cada conversación con IA gasta del cupo del
  // plan. La comprobación que hace el propio widget es cosmética (quien edite el JavaScript
  // se la salta); ESTA es la que protege el cupo, porque el navegador pone `Origin` en las
  // peticiones cruzadas y una página no puede falsificarla.
  //
  // Alcance honesto: frena a quien copie el fragmento a otra web, no a quien escriba un
  // script — fuera del navegador la cabecera se pone a mano.
  //
  // Solo aplica a peticiones SIN sesión: desde el panel se crean conversaciones a mano y esas
  // ya vienen autenticadas. Sin dominios configurados no se comprueba nada, para no romper
  // los canales que ya funcionan.
  if (!req.user && channelType === 'webchat' && channelId) {
    try {
      const w = require('./webchatWidget.controller')
      const canal = await w.buscarCanal(accId, agId, channelId)
      const permitidos = w.normalizarDominios(canal?.config?.allowedDomains)
      if (permitidos.length) {
        const host = w.hostDe(req.headers.origin) || w.hostDe(req.headers.referer)
        if (!w.dominioPermitido(host, permitidos)) {
          console.warn('[createConvo] webchat bloqueado · dominio no autorizado:', host || '(sin origen)', '· canal', channelId)
          return res.status(403).json({ error: 'Este chat no está autorizado en este dominio.', code: 'domain_not_allowed' })
        }
      }
    } catch (e) { console.warn('[createConvo dominios]', e.message) }
  }
  const id       = `conv_${Date.now()}_${guestId || uid()}`
  const initials = (guestName || '').slice(0, 2).toUpperCase()
  const ts       = Date.now()
  // Origen del lead: el que envía el cliente (webchat ya clasificado) o derivado del
  // link de entrada (channelId). El webchat sí usa `link` para su enlace de entrada.
  const originObj = (origin && typeof origin === 'object')
    ? origin
    : { type: channelId ? 'link' : 'direct', linkId: channelId || null }

  const { id: contactId, existed, hasMemory } = await findOrCreateContact(accId, { guestName, guestId, waFrom, messengerFrom, igFrom, channelType, origin: originObj })
  const returning = !!(existed || hasMemory)
  const localVars = { user_name: guestName || '' }   // variable canónica del nombre (antes var_nombre)
  if (contactId) {
    localVars.contact_id = contactId
    // Memoria permanente del cliente (de conversaciones pasadas) → la nueva
    // conversación arranca conociéndolo.
    try { const mem = await require('../services/conversationMemory').getContactMemory(accId, contactId); if (mem) localVars._summary = mem } catch {}
  }
  if (returning) localVars._returning = true

  try {
    // Reparto IA/Humano por % (si está activo en el agente): fija ai_enabled + etiqueta.
    const route = await routeNewConversation(accId, agId)
    await pool.query(
      `INSERT INTO conversations
       (id,account_id,agent_id,channel_id,channel_type,guest_name,guest_id,wa_from,messenger_from,ig_from,initials,preview,unread,ai_enabled,labels,pipeline_cards,local_vars,debug_log,origin,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, accId, agId, channelId, channelType, guestName, guestId,
       waFrom || null, messengerFrom || null, igFrom || null,
       initials, '', 0, route.aiEnabled, JSON.stringify(route.labelIds), '[]', JSON.stringify(localVars), '[]', JSON.stringify(originObj), ts, ts]
    )
    // Bandera de recurrente vía UPDATE aparte (defensivo: si la columna aún no
    // existe por migración, no rompe la creación de la conversación).
    if (returning) { try { await pool.query('UPDATE conversations SET returning_contact=1 WHERE id=? AND account_id=?', [id, accId]) } catch {} }
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
    const map = { guestName:'guest_name', preview:'preview', unread:'unread', aiEnabled:'ai_enabled', labels:'labels', pipelineCards:'pipeline_cards', localVars:'local_vars', debugLog:'debug_log', assignedTo:'assigned_to', origin:'origin', archived:'archived', blocked:'blocked', followup:'followup' }
    const sets = []
    const vals = []
    for (const [key, col] of Object.entries(map)) {
      if (req.body[key] !== undefined) {
        sets.push(`${col}=?`)
        const v = req.body[key]
        vals.push(typeof v === 'object' ? JSON.stringify(v) : v)
      }
    }
    // Equipo asignado (columna simple, no JSON): '' o null → desasignar.
    if (req.body.teamId !== undefined) { sets.push('team_id=?'); vals.push(req.body.teamId || null) }
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
      const [[m]] = await pool.query('SELECT email FROM members WHERE account_id=? AND id=?', [accId, assignee.id])
      // Se emite al room de la cuenta con id+email del asignado; el navegador filtra por
      // "soy yo" (id o email) → robusto aunque el id de miembro difiera de la sesión activa.
      socket.emit(accId, 'conv:assigned', {
        accId, agId, convId,
        assigneeId: assignee.id, assigneeEmail: m?.email || null,
        guestName:  c?.guest_name || 'Conversación',
        preview:    c?.preview || '',
        assignedBy: req.user?.name || 'Un compañero',
      })
      // Aviso por correo al asignado (si activó "Transferencia a asesor → Correo").
      try { require('../services/emailNotify').onAssigned(accId, { convId, agId, assigneeId: assignee.id, guestName: c?.guest_name, assignedBy: req.user?.name }) } catch {}
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
      // El cliente volvió a escribir → se reabre la conversación: se reanudan los recontactos.
      delete lv._recontact_stopped
      if (lv._case_status === 'closed') delete lv._case_status
      await pool.query('UPDATE conversations SET local_vars=? WHERE id=? AND account_id=?', [JSON.stringify(lv), convId, accId])
      // Métrica de facturación por contactos: contacto distinto con actividad en el ciclo.
      if (lv.contact_id) { try { require('../services/subscriptions').markContactActive(accId, lv.contact_id) } catch {} }
    } catch { /* non-critical */ }
  }

  const msg = { id, sender, content, ts, ...rest }
  socket.emit(accId, 'message:new', { accId, agId, convId, message: msg })
  // El eco a la sala del chat lleva TAMBIÉN cuenta y agente. No es información de más: al abrir
  // un chat el asesor entra en `conv:<id>` (por la presencia), así que recibe este eco igual que
  // el visitante — y el inbox indexa sus listas por `${accId}_${agId}`. Sin estos dos campos
  // calculaba la clave `undefined_undefined`, que no existe, y el mensaje no se pintaba.
  socket.emitToConv(convId, 'message:new', { accId, agId, convId, message: msg })
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
// Canales con ventana de servicio de 24 h (Meta rechaza el texto libre fuera de ella).
// Antes solo se validaba WhatsApp; Messenger e Instagram tienen la misma regla.
const WINDOW_CHANNELS = { whatsapp: 24, messenger: 24, instagram: 24 }
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' }

/**
 * Estado de la ventana de servicio de una conversación.
 * → { applies, open, lastTs, expiresAt }. `applies:false` = canal sin ventana (webchat/prueba).
 */
async function serviceWindow(convId, channelType) {
  const hours = WINDOW_CHANNELS[channelType]
  if (!hours) return { applies: false, open: true, lastTs: 0, expiresAt: 0 }
  const [[lastIn]] = await pool.query(
    "SELECT MAX(ts) AS ts FROM messages WHERE conversation_id=? AND sender='user'", [convId]
  )
  const lastTs = Number(lastIn?.ts) || 0
  const expiresAt = lastTs ? lastTs + hours * 3600 * 1000 : 0
  return { applies: true, open: !!lastTs && Date.now() < expiresAt, lastTs, expiresAt }
}

/**
 * Entrega un mensaje del asesor al canal y lo persiste. Devuelve
 * `{ ok:true, message }` o `{ ok:false, status, error, code }`.
 *
 * Extraído de `sendManual` para que el worker de MENSAJES PROGRAMADOS use exactamente
 * la misma ruta de entrega (ventana de servicio incluida) y no se duplique la lógica.
 */
async function deliverManualMessage(accId, agId, convId, { text, senderName, replyToId } = {}) {
  if (!text || !String(text).trim()) return { ok: false, status: 400, error: 'Texto vacío' }

  // Tope de contactos de CRM agotado → no se puede escribir desde AVI. Se comprueba AQUÍ
  // porque este es el embudo único de envío manual: la web, la app móvil y los mensajes
  // programados pasan todos por esta función. Un tope aplicado solo en la interfaz web se
  // esquivaría abriendo la app.
  try {
    const gate = await require('../services/subscriptions').sendGate(accId)
    if (gate && !gate.allowed) {
      return { ok: false, status: 402, code: gate.reason, error: gate.message }
    }
  } catch (e) { console.warn('[sendGate]', e.message) }   // sin suscripción → sin tope

  const [[conv]] = await pool.query(
    'SELECT channel_type, channel_id, wa_from, messenger_from, ig_from FROM conversations WHERE id=? AND account_id=?',
    [convId, accId]
  )
  if (!conv) return { ok: false, status: 404, error: 'Conversación no encontrada' }
  const type = conv.channel_type

  // Ventana de servicio de 24 h (WhatsApp, Messenger e Instagram): se reinicia con cada
  // mensaje entrante del cliente. Fuera de ella la API de Meta rechaza el texto libre.
  const win = await serviceWindow(convId, type)
  if (win.applies && !win.open) {
    return {
      ok: false, status: 409, code: 'window_closed',
      error: `La ventana de 24 h de ${CHANNEL_LABEL[type] || type} está cerrada. Solo puedes enviar una plantilla aprobada o ejecutar un flujo.`,
    }
  }

  // ¿El asesor está citando un mensaje? Resolvemos su wamid y contenido.
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

  let providerMsgId = null
  let status = null
  try {
    if (type === 'whatsapp' && conv.wa_from) {
      const ch = await resolveChannelConfig(accId, agId, 'whatsapp', conv.channel_id)
      const cfg = ch?.config || {}
      if (!cfg.phoneNumberId || !cfg.accessToken) return { ok: false, status: 400, error: 'Canal WhatsApp sin configurar' }
      const r = await sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: conv.wa_from, text, contextMessageId: quotedWamid })
      providerMsgId = r?.messages?.[0]?.id || null; status = 'sent'
    } else if (type === 'messenger' && conv.messenger_from) {
      const ch = await resolveChannelConfig(accId, agId, 'messenger', conv.channel_id)
      const cfg = ch?.config || {}
      if (!cfg.pageId || !cfg.pageAccessToken) return { ok: false, status: 400, error: 'Canal Messenger sin configurar' }
      const r = await sendMessengerText({ pageId: cfg.pageId, pageAccessToken: cfg.pageAccessToken, recipientId: conv.messenger_from, text })
      providerMsgId = r?.message_id || null; status = 'sent'
    } else if (type === 'instagram' && conv.ig_from) {
      const ch = await resolveChannelConfig(accId, agId, 'instagram', conv.channel_id)
      const cfg = ch?.config || {}
      if (!cfg.igAccountId || !cfg.pageAccessToken) return { ok: false, status: 400, error: 'Canal Instagram sin configurar' }
      const r = await sendInstagramText({ igAccountId: cfg.igAccountId, pageAccessToken: cfg.pageAccessToken, recipientId: conv.ig_from, text })
      providerMsgId = r?.message_id || null; status = 'sent'
    }
    // webchat / test: no hay envío externo; solo se persiste
  } catch (e) {
    return { ok: false, status: 502, error: e.message || 'No se pudo entregar el mensaje al canal' }
  }

  const out = await appendMessageCore(accId, agId, convId, {
    role: 'assistant', sender: 'human',
    senderName: senderName || 'Asesor',
    content: String(text), channel: type, channelId: conv.channel_id,
    ...(replyTo ? { replyTo } : {}),
    ...(providerMsgId ? { waMessageId: providerMsgId } : {}),
    ...(status ? { status } : {}),
  })
  return { ok: true, message: out }
}

const sendManual = async (req, res) => {
  const { accId, agId, convId } = req.params
  const { text, senderName, replyToId } = req.body || {}
  try {
    const r = await deliverManualMessage(accId, agId, convId, {
      text, replyToId, senderName: senderName || req.user?.name || 'Asesor',
    })
    if (!r.ok) return res.status(r.status || 500).json({ error: r.error, ...(r.code ? { code: r.code } : {}) })
    return res.json({ ok: true, ...r.message })
  } catch (err) {
    console.error('[SEND MANUAL]', err)
    return res.status(500).json({ error: 'Error interno' })
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
    // Anclaje al lead: si la variable editada es nombre/teléfono/email, refleja el cambio
    // en el contacto vinculado (o por teléfono). Best-effort, no bloquea la respuesta.
    try {
      const contactSync = require('../services/contactSync')
      const field = contactSync.isBoundVar(varId) ? contactSync.contactFieldForVar(varId) : null
      if (field) {
        await contactSync.syncContactFromVars(accId, vars, [field])
        // Si cambió el NOMBRE, actualiza también el nombre visible del chat (guest_name):
        // es lo que muestra el Inbox. Sin esto, la lista/panel seguía en "Invitado" aunque
        // la variable y el contacto ya tuvieran el nombre nuevo.
        if (field === 'name' && String(value ?? '').trim()) {
          await pool.query('UPDATE conversations SET guest_name=? WHERE id=? AND account_id=?', [String(value), convId, accId])
          // Propaga a las DEMÁS conversaciones del mismo contacto (nombre + alias ancladas).
          if (vars.contact_id) { try { await contactSync.syncConversationsFromContact(accId, vars.contact_id, { name: String(value) }) } catch { /* best-effort */ } }
        }
      }
    } catch { /* non-critical */ }
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
  if (existing) {
    // Una conversación que ya existía salía por aquí SIN pasar por la creación de contacto,
    // así que los chats abiertos antes de esta lógica no tenían contacto en el CRM y nunca
    // iban a tenerlo. Se repara al vuelo: el próximo mensaje de cada chat lo enlaza.
    try {
      const [[c]] = await pool.query('SELECT local_vars FROM conversations WHERE id=?', [existing.id])
      const lv = parseJ(c?.local_vars, {})
      if (!lv.contact_id) {
        const args = { guestName, guestId: String(lv.guest_id || ''), channelType, origin: origin || { type: 'direct' } }
        if (lookupCol === 'wa_from')             args.waFrom        = lookupVal
        else if (lookupCol === 'messenger_from') args.messengerFrom = lookupVal
        else if (lookupCol === 'ig_from')        args.igFrom        = lookupVal
        const { id: contactId } = await findOrCreateContact(accId, args)
        if (contactId) {
          lv.contact_id = contactId
          await pool.query('UPDATE conversations SET local_vars=? WHERE id=?', [JSON.stringify(lv), existing.id])
        }
      }
    } catch (e) { console.warn('[convo existente sin contacto]', e.message) }
    return existing.id
  }
  await pool.query('UPDATE counters SET value=value+1 WHERE name="guest_counter"')
  const [[ctr]] = await pool.query('SELECT value FROM counters WHERE name="guest_counter"')
  const n  = ctr?.value || Date.now()
  const id = `conv_${channelType}_${Date.now()}_${n}`
  const ts = Date.now()

  // Origen del lead: el que llega (anuncio/referral de Meta) o, por defecto, un
  // mensaje de entrada DIRECTO. En canales sociales `channelId` es el canal (no un
  // punto de entrada), así que un mensaje sin referral es "directo", no "link".
  const originObj = origin || { type: 'direct' }

  const contactArgs = { guestName, guestId: String(n), channelType, origin: originObj }
  if (lookupCol === 'wa_from')        contactArgs.waFrom        = lookupVal
  else if (lookupCol === 'messenger_from') contactArgs.messengerFrom = lookupVal
  else if (lookupCol === 'ig_from')   contactArgs.igFrom        = lookupVal
  const { id: contactId, existed, hasMemory } = await findOrCreateContact(accId, contactArgs)
  const returning = !!(existed || hasMemory)
  const localVars = { user_name: guestName || '' }   // variable canónica del nombre (antes var_nombre)
  if (contactId) {
    localVars.contact_id = contactId
    try { const mem = await require('../services/conversationMemory').getContactMemory(accId, contactId); if (mem) localVars._summary = mem } catch {}
  }
  if (returning) localVars._returning = true

  // Reparto IA/Humano por % (round-robin del agente) para la conversación nueva.
  const route = await routeNewConversation(accId, agId)
  const cols = {
    id, account_id: accId, agent_id: agId,
    channel_id: channelId || channelType, channel_type: channelType,
    guest_name: guestName, guest_id: String(n),
    initials: (guestName || '').slice(0, 2).toUpperCase(),
    preview: '', unread: 1, ai_enabled: route.aiEnabled,
    labels: JSON.stringify(route.labelIds), pipeline_cards: '[]',
    local_vars: JSON.stringify(localVars),
    debug_log: '[]',
    origin: JSON.stringify(originObj),
    created_at: ts, updated_at: ts,
  }
  cols[lookupCol] = lookupVal
  const keys = Object.keys(cols); const vals = Object.values(cols)
  await pool.query(`INSERT INTO conversations (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, vals)
  // Bandera de recurrente vía UPDATE aparte (defensivo ante la columna aún no migrada).
  if (returning) { try { await pool.query('UPDATE conversations SET returning_contact=1 WHERE id=? AND account_id=?', [id, accId]) } catch {} }
  // Suma 1 al consumo de conversaciones de la suscripción (límites demo/mensuales).
  try { require('../services/subscriptions').incrementConversation(accId) } catch {}
  // Aviso por correo de "chat nuevo" (1 vez) a quien lo activó en su perfil.
  try { require('../services/emailNotify').onNewChat(accId, { convId: id, agId, guestName, channelType }) } catch {}
  // Notificación WEB de "chat nuevo" (con botón "Ir al chat") a la cuenta.
  try { socket.emit(accId, 'conv:new', { accId, agId, convId: id, guestName, channelType }) } catch {}
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

// ── Sugerencia de respuesta con IA (asistente al asesor en el inbox) ──────────
// Redacta una respuesta borrador al ÚLTIMO mensaje del cliente usando el modelo/clave
// de la cuenta. Es ayuda para el asesor: devuelve solo texto, NO envía nada.
const suggestReply = async (req, res) => {
  const { accId, agId, convId } = req.params
  try {
    const [[conv]] = await pool.query('SELECT id FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' })
    const [rows] = await pool.query('SELECT sender, content, metadata FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 15', [convId])
    const history = rows.reverse().map(m => {
      const meta = parseJ(m.metadata, {})
      const content = m.content || (meta.kind ? `[${meta.kind}]` : '')
      return { role: m.sender === 'user' ? 'user' : 'assistant', content: String(content || '').trim() }
    }).filter(m => m.content)
    if (!history.length) return res.status(400).json({ error: 'No hay mensajes para sugerir una respuesta.' })

    const account = await require('../flow/store').loadAccount(accId)
    const ai = require('../services/aiClient')
    let provider = account?.defaultPromptProvider || ai.detectProvider(account?.defaultPromptModel || 'gpt-4o-mini')
    let model    = account?.defaultPromptModel || 'gpt-4o-mini'
    let apiKey   = ai.getApiKey(account, provider)
    // Sin clave del proveedor por defecto → intenta OpenAI (el más común para esto).
    if (!apiKey && ai.getApiKey(account, 'openai')) { provider = 'openai'; model = 'gpt-4o-mini'; apiKey = ai.getApiKey(account, 'openai') }
    if (!apiKey) return res.status(400).json({ error: 'La cuenta no tiene una API Key de IA configurada.' })

    const sys = 'Eres un asesor humano de atención al cliente de este negocio. A partir del historial de la conversación, redacta UNA sola respuesta breve, cordial y profesional al ÚLTIMO mensaje del cliente, en su MISMO idioma. Devuelve SOLO el texto de la respuesta, sin comillas ni explicaciones.'
    const suggestion = await ai.chat({ provider, model, apiKey, messages: [{ role: 'system', content: sys }, ...history], maxTokens: 300, temperature: 0.6 })
    res.json({ suggestion: String(suggestion || '').trim() })
  } catch (e) {
    console.error('[suggestReply]', e.message)
    res.status(500).json({ error: e.message || 'No se pudo generar la sugerencia' })
  }
}

// ── Mensajes destacados ───────────────────────────────────────────────────────
// El asesor marca mensajes clave de un chat (un dato, un acuerdo, una dirección) para
// tenerlos a mano sin releer toda la conversación.
const starMessage = async (req, res) => {
  // `agId` hace falta para el evento: el frontend recarga con /api/conversations/:accId/:agId
  // y sin él la URL salía con 'undefined', la recarga fallaba en silencio y la estrella
  // nunca aparecía. Era el motivo de que 'destacar' pareciera no funcionar.
  const { accId, agId, convId, msgId } = req.params
  const starred = req.body?.starred !== false
  try {
    const [[c]] = await pool.query('SELECT id FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada' })
    await pool.query(
      'UPDATE messages SET starred=?, starred_at=?, starred_by=? WHERE id=? AND conversation_id=?',
      [starred ? 1 : 0, starred ? Date.now() : null, starred ? (req.user?.name || req.user?.email || 'Asesor') : null, msgId, convId]
    )
    socket.emit(accId, 'convos:updated', { accId, agId })
    res.json({ ok: true, starred })
  } catch (err) { console.error('[starMessage]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Mensajes destacados de una conversación (para el panel lateral del chat).
const listStarred = async (req, res) => {
  const { accId, convId } = req.params
  try {
    const [rows] = await pool.query(
      'SELECT * FROM messages WHERE conversation_id=? AND starred=1 ORDER BY ts ASC LIMIT 200', [convId])
    res.json(rows.map(m => ({
      id: m.id, sender: m.sender, content: m.content, ts: m.ts,
      starredAt: m.starred_at, starredBy: m.starred_by, ...parseJ(m.metadata, {}),
    })))
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

/**
 * Ejecuta un flujo A MANO sobre una conversación (POST …/:convId/run-flow).
 *
 * La web hace esto con su motor del NAVEGADOR (`lib/flowEngine`), que la app móvil no tiene
 * ni puede tener. Con este endpoint el flujo corre en el servidor, así que sirve igual para
 * el móvil y para cualquier otro cliente futuro; el resultado (mensajes, etiquetas, tickets…)
 * aparece en los dos sitios por socket, como con cualquier flujo automático.
 *
 * Se lanza SIN esperar a que termine: un flujo con nodos de IA puede tardar bastante y la
 * app se quedaría con la petición colgada. Quien lo dispara recibe el "ok" y ve la respuesta
 * llegar al chat como cualquier otro mensaje.
 */
const runFlowManually = async (req, res) => {
  const { accId, agId, convId } = req.params
  const flowId = String(req.body?.flowId || '').trim()
  if (!flowId) return res.status(400).json({ error: 'Falta el flujo a ejecutar' })
  try {
    // La conversación tiene que ser de esta cuenta: el id viene del cliente.
    const [[conv]] = await pool.query('SELECT id FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' })
    const [[flow]] = await pool.query('SELECT id, name, nodes FROM flows WHERE id=? AND account_id=?', [flowId, accId])
    if (!flow) return res.status(404).json({ error: 'Flujo no encontrado en esta cuenta' })
    if (!(parseJ(flow.nodes, []) || []).length) return res.status(400).json({ error: 'Ese flujo no tiene nodos' })

    const engine = require('../flow/engine')
    if (engine.isRunning && engine.isRunning(convId)) {
      return res.status(409).json({ error: 'Ya hay un flujo en curso en esta conversación. Espera a que termine.' })
    }
    // `triggeredBy` deja constancia de QUIÉN lo lanzó en el historial de ejecuciones.
    engine.executeFlow({
      flowId, accId, agId, convId,
      triggeredBy: { type: 'manual', id: req.user?.id || null, name: req.user?.name || req.user?.email || 'Asesor' },
    }).catch(e => console.warn('[run-flow]', flowId, e.message))

    res.json({ ok: true, flowId, name: flow.name })
  } catch (err) {
    console.error('[RUN FLOW]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = {
  runFlowManually,
  listConvos, getConvo, createConvo, updateConvo, deleteConvo, markRead,
  appendMessage, sendManual, appendDebug, patchVars, getGuest, updateMemory,
  createWhatsApp, createMessenger, createInstagram, createSocial, suggestReply,
  starMessage, listStarred,
  // Reusable cores for the server-side flow engine
  createOrGetSocialConvo,
  // Reutilizados por el worker de mensajes programados
  deliverManualMessage, serviceWindow,
}
