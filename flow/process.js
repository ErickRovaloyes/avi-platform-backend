'use strict'
/**
 * Webhook processing (backend port de webhookHandler.js).
 *
 * Antes esto corría EN EL NAVEGADOR vía SSE. Ahora corre en el servidor: al
 * llegar un webhook de Meta, persistimos el mensaje del usuario, ejecutamos el
 * flujo de entrada del agente y entregamos la respuesta al canal real. La UI se
 * actualiza por socket.io (message:new / convos:updated).
 */

const store = require('./store')
const engine = require('./engine')
const mediaAI = require('../services/mediaAI')
const {
  parseWhatsAppWebhook, sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppRead, sendWhatsAppCtaUrl,
  parseMessengerWebhook, sendMessengerText, sendMessengerButtons,
  parseInstagramWebhook, sendInstagramText,
} = require('../services/metaSend')
const { uploadWhatsAppMedia, sendWhatsAppMediaMessage } = require('../services/metaMedia')
const metaProfile = require('../services/metaProfile')
const pool = require('../db')

// Pone el nombre real en una conversación que aún tiene el marcador ("FB #5326").
//
// Solo sustituye MARCADORES: si un asesor escribió el nombre a mano, o el contacto ya
// tenía uno, no se toca. Meta no siempre devuelve nombre —perfiles restringidos, normativa
// de privacidad de la región— y sobrescribir un dato bueno con uno peor sería un retroceso.
async function upgradeGuestName(convId, nombre, foto) {
  if (!convId || !nombre || metaProfile.isPlaceholder(nombre)) return
  try {
    const [[c]] = await pool.query('SELECT guest_name, local_vars FROM conversations WHERE id=?', [convId])
    if (!c || !metaProfile.isPlaceholder(c.guest_name)) return
    const iniciales = nombre.trim().slice(0, 2).toUpperCase()
    await pool.query('UPDATE conversations SET guest_name=?, initials=? WHERE id=?', [nombre, iniciales, convId])
    // La variable canónica que usan los prompts y los flujos ({{user_name}}).
    let lv = {}; try { lv = JSON.parse(c.local_vars || '{}') } catch {}
    if (metaProfile.isPlaceholder(lv.user_name)) {
      lv.user_name = nombre
      await pool.query('UPDATE conversations SET local_vars=? WHERE id=?', [JSON.stringify(lv), convId])
    }
    // Y la ficha del contacto en el CRM, para que no quede como "FB #…" en la agenda.
    if (lv.contact_id) {
      await pool.query('UPDATE contacts SET name=? WHERE id=? AND (name IS NULL OR name="" OR name LIKE "FB #%" OR name LIKE "IG #%" OR name = "Visitante" OR name LIKE "Visitante %" OR name LIKE "Guest %")', [nombre, lv.contact_id])
    }
  } catch (e) { console.warn('[upgradeGuestName]', e.message) }
}

// Transcribe la nota de voz del usuario (si la hay) y usa la transcripción como
// texto del mensaje → así se persiste como contenido y queda en {{_lastUserMessage}}
// ANTES de ejecutar el flujo (el agente IA solo procesa texto). Si falla, deja
// constancia en el log de la conversación para que sea diagnosticable.
async function transcribeIfAudio(accId, agId, convId, msg) {
  if (msg.text || msg.internalMedia?.kind !== 'audio') return msg.text || ''
  try {
    const text = await mediaAI.transcribeMedia(accId, msg.internalMedia.mediaId)
    if (text) {
      msg.text = text
      try { await store.appendDebugEntry(accId, agId, convId, { type: 'flow_run', title: `🎤 Audio transcrito: "${text.slice(0, 80)}"`, detail: {} }) } catch {}
    }
  } catch (e) {
    console.warn('[flow/process] transcripción', e.message)
    try { await store.appendDebugEntry(accId, agId, convId, { type: 'error', title: `No se pudo transcribir el audio: ${e.message}`, detail: { mediaId: msg.internalMedia?.mediaId } }) } catch {}
  }
  return msg.text || ''
}

// Dedup de mensajes entrantes por messageId (defensa contra reentregas).
const processedMessageIds = new Set()
function alreadyProcessed(messageId) {
  if (!messageId) return false
  if (processedMessageIds.has(messageId)) return true
  processedMessageIds.add(messageId)
  if (processedMessageIds.size > 2000) {
    const oldest = processedMessageIds.values().next().value
    processedMessageIds.delete(oldest)
  }
  return false
}

async function getAgent(accId, agentId) {
  const account = await store.loadAccount(accId)
  const agent = account?.agents?.find(a => a.id === agentId)
  return { account, agent }
}

// ¿La IA está activa para esta conversación? (un asesor humano puede haberla apagado)
async function aiActive(accId, agentId, convId) {
  const convos = await store.readConvos(accId, agentId)
  const conv = (convos || []).find(c => c.id === convId)
  return conv?.aiEnabled !== false
}

// Coordinador con INTERRUPCIÓN: si llega un mensaje nuevo mientras se genera una
// respuesta, se cancela la generación en curso y se REHACE tomando el mensaje más
// reciente (el nodo IA relee todo el historial de la BD → incluye el mensaje nuevo).
// Un solo ciclo por conversación; los mensajes que llegan durante el ciclo marcan
// "rehacer" y abortan la generación actual. Evita respuestas duplicadas.
const _busy = new Set()
const _redo = new Set()
async function runWithInterrupt(accId, agentId, convId, makeRun) {
  if (_busy.has(convId)) { _redo.add(convId); engine.cancel(convId); return }
  _busy.add(convId)
  try {
    do {
      _redo.delete(convId)
      const text = await store.lastUserText(accId, convId)
      await makeRun(text)
    } while (_redo.has(convId))
  } finally { _busy.delete(convId); _redo.delete(convId) }
}

// ─── WhatsApp ──────────────────────────────────────────────────────────────────
async function processWhatsApp(accId, agentId, body) {
  const messages = parseWhatsAppWebhook(body)
  const { agent } = await getAgent(accId, agentId)
  if (!agent) { console.warn('[flow/process] WA agente no encontrado:', agentId); return }

  for (const msg of messages) {
    if (!msg.text && !msg.internalMedia) continue
    if (alreadyProcessed(msg.messageId)) { console.log('[flow/process] WA duplicado ignorado:', msg.messageId); continue }

    const channel = (agent.channels || []).find(
      ch => ch.type === 'whatsapp' && ch.status === 'connected' && ch.config?.phoneNumberId === msg.phoneNumberId
    ) || { id: 'whatsapp', name: 'WhatsApp', config: agent.whatsapp || {} }

    // Origen del lead: anuncio Click-to-WhatsApp de Meta (si el chat se inició así).
    const waOrigin = msg.referral ? {
      type: 'ad', platform: 'meta',
      adId: msg.referral.source_id || null,
      campaign: msg.referral.headline || null,
      source: msg.referral.source_type || 'ad',
      clickId: msg.referral.ctwa_clid || null,
      sourceUrl: msg.referral.source_url || null,
      headline: msg.referral.headline || null,
    } : null
    const convId = await store.createOrGetWhatsAppConvo(accId, agentId, msg.from, msg.fromName, channel?.id, waOrigin)

    // Idempotencia persistente: si este waMessageId ya se guardó, no reprocesar.
    if (await store.messageExistsByProviderId(convId, msg.messageId)) {
      console.log('[flow/process] WA ya procesado en DB:', msg.messageId); continue
    }

    // Audio → transcripción automática (queda como texto del mensaje)
    await transcribeIfAudio(accId, agentId, convId, msg)

    // ¿El cliente respondió/citó un mensaje anterior? Resolvemos su contenido para
    // mostrarlo en la bandeja Y dárselo de contexto al asistente.
    let replyTo = null
    if (msg.quotedId) {
      const q = await store.getMessageByProviderId(convId, msg.quotedId)
      if (q) replyTo = { id: q.id, content: q.content, sender: q.sender, kind: q.kind || null, filename: q.filename || null }
    }

    await store.appendMsg(accId, agentId, convId, {
      role: 'user', sender: 'user',
      senderName: msg.fromName || msg.from,
      content: msg.text || msg.mediaCaption || '',
      ts: Date.now(),
      waMessageId: msg.messageId,
      channel: 'whatsapp', channelId: channel?.id,
      ...(replyTo ? { replyTo } : {}),
      ...(msg.internalMedia ? {
        mediaId: msg.internalMedia.mediaId, kind: msg.internalMedia.kind,
        mime: msg.internalMedia.mime, filename: msg.internalMedia.filename, sizeBytes: msg.internalMedia.sizeBytes,
      } : {}),
    })

    // Auto opt-out: si el cliente pide la baja (BAJA/STOP/…), no recibe más masivos.
    try { require('../services/campaigns').maybeOptOut(accId, msg.from, msg.text || '') } catch {}

    // Canal EXCLUSIVO del Copiloto de negocio (gate por contraseña + bloqueo a 3 fallos).
    // No corre el flujo normal: responde el copiloto del CRM.
    if (channel?.config?.copilot) {
      try { await require('../services/copilotWhatsApp').handle(accId, agentId, channel, msg, convId) }
      catch (e) { console.warn('[copilotWhatsApp]', e.message) }
      continue
    }

    if (!(await aiActive(accId, agentId, convId))) continue

    // Indicador "escribiendo…" mientras el flujo genera la respuesta (y marca leído).
    if (channel?.config?.phoneNumberId && channel?.config?.accessToken && msg.messageId) {
      sendWhatsAppRead({ phoneNumberId: channel.config.phoneNumberId, accessToken: channel.config.accessToken, messageId: msg.messageId, typing: true }).catch(() => {})
    }

    const waOutbound = async (text, meta) => {
      const cfg = channel?.config
      if (!cfg?.phoneNumberId || !cfg?.accessToken) return
      // Botón con enlace (p. ej. "Enviar calendario") → botón interactivo nativo.
      if (meta?.calendar?.url) {
        try {
          return await sendWhatsAppCtaUrl({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: msg.from, bodyText: meta.calendar.message || text, buttonText: meta.calendar.buttonText, url: meta.calendar.url })
        } catch (e) {
          console.warn('[WA cta_url] falló, fallback a texto:', e.message)
          await store.appendDebugEntry(accId, agentId, convId, { type: 'error', title: `WhatsApp: botón de calendario falló — ${e.message}`, detail: { url: meta.calendar.url } }).catch(() => {})
          // Fallback: texto con el enlace (siempre clickeable en WhatsApp)
          if (text) return await sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: msg.from, text })
          throw e
        }
      }
      if (meta?.media?.url) {
        // Media NUESTRA (CMS / tabla media): subimos los bytes a WhatsApp y enviamos
        // por id — mucho más fiable que el envío por link (Meta es quisquilloso al
        // descargar enlaces). Para URLs externas seguimos enviando por link.
        if (meta.media.mediaId) {
          try {
            const m = await store.getMediaBytes(accId, meta.media.mediaId)
            if (m) {
              const waId = await uploadWhatsAppMedia({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, buffer: m.buffer, mime: m.mime, filename: meta.media.filename || m.filename })
              return await sendWhatsAppMediaMessage({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: msg.from, kind: meta.media.kind, mediaId: waId, caption: meta.caption, filename: meta.media.filename || m.filename })
            }
          } catch (e) {
            console.warn('[WA media upload] fallback a link:', e.message)
            await store.appendDebugEntry(accId, agentId, convId, { type: 'error', title: `WhatsApp: subida de media falló, intento por link — ${e.message}`, detail: { mediaId: meta.media.mediaId } }).catch(() => {})
          }
        }
        return await sendWhatsAppMedia({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: msg.from, kind: meta.media.kind, link: meta.media.url, caption: meta.caption, filename: meta.media.filename })
      }
      if (text) return await sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: msg.from, text })
    }
    // El mensaje citado se pasa como _quotedMessage (el nodo Agente IA lo añade al
    // contexto). `message` se deja crudo para que el matching por palabra clave no
    // se vea afectado por el texto citado.
    const quotedCtx = replyTo?.content ? { _quotedMessage: replyTo.content, _quotedSender: replyTo.sender } : {}
    // Aviso configurable para clientes recurrentes (override por canal). ai.js lo usa
    // solo si la conversación está marcada como recurrente.
    const _returningNotice = channel?.config?.returningNotice || ''
    const doRun = async (latest) => {
      const m = latest || msg.text
      if (agent.fallbackFlowId) {
        await engine.executeFlow({
          flowId: agent.fallbackFlowId, accId, agId: agentId, convId,
          triggerContext: { message: m, _lastUserMessage: m, _returningNotice, ...quotedCtx },
          outbound: waOutbound,
        })
      } else {
        await engine.runTrigger({ trigger: 'keyword', accId, agId: agentId, convId, context: { message: m, _returningNotice, ...quotedCtx }, outbound: waOutbound })
      }
    }
    // Interrupción activable por agente: si está desactivada, se ignora el mensaje
    // nuevo mientras la IA genera (comportamiento anterior); si no, se interrumpe y rehace.
    if (agent.interruptEnabled === false) { if (engine.isRunning(convId)) continue; await doRun(msg.text) }
    else await runWithInterrupt(accId, agentId, convId, doRun)
  }
}

// Origen del lead desde un `referral` de Meta (Messenger/Instagram): anuncio
// Click-to-Messenger/Instagram, o un referral m.me?ref=<punto de entrada>.
function metaOrigin(ref) {
  if (!ref) return null
  const adId = ref.ad_id || ref.ads_context_data?.ad_id || null
  if (adId || ref.source === 'ADS' || ref.type === 'ad') {
    return { type: 'ad', platform: 'meta', adId, campaign: ref.ads_context_data?.ad_title || ref.ad_title || null, source: ref.source || 'ADS', ref: ref.ref || null }
  }
  return { type: 'link', platform: 'meta', linkId: ref.ref || ref.source || null, source: ref.source || null }
}

// ─── Messenger ─────────────────────────────────────────────────────────────────
async function processMessenger(accId, agentId, body) {
  const messages = parseMessengerWebhook(body)
  const { agent } = await getAgent(accId, agentId)
  if (!agent) { console.warn('[flow/process] FB agente no encontrado:', agentId); return }

  for (const msg of messages) {
    if (!msg.text && !msg.internalMedia) continue
    if (alreadyProcessed(msg.messageId)) { console.log('[flow/process] FB duplicado ignorado:', msg.messageId); continue }

    const channel = (agent.channels || []).find(
      ch => ch.type === 'messenger' && ch.status === 'connected' && ch.config?.pageId === msg.pageId
    )
    if (!channel) { console.warn('[flow/process] Canal Messenger no encontrado:', msg.pageId); continue }

    // El webhook no trae el nombre: se pide a la API de perfil con el token de la página.
    // Sin esto la conversación se queda en "FB #5326" y no se sabe con quién se habla.
    const perfilFb = await metaProfile.fetchProfile(msg.senderId, channel.config?.pageAccessToken, "messenger")
    const nombreFb = msg.senderName || perfilFb?.name || ""
    const convId = await store.createOrGetMessengerConvo(accId, agentId, msg.senderId, nombreFb, channel.id, metaOrigin(msg.referral))
    // Conversaciones que YA existían con el marcador: se les pone el nombre real ahora que
    // se conoce. createOrGet solo lo aplica al crear, así que sin esto los chats abiertos
    // antes de este arreglo se quedarían con "FB #…" para siempre.
    await upgradeGuestName(convId, nombreFb, perfilFb?.photo)

    if (await store.messageExistsByProviderId(convId, msg.messageId)) {
      console.log('[flow/process] FB ya procesado en DB:', msg.messageId); continue
    }

    // SALIENTE (echo): lo envió el negocio desde la app de Messenger u otra herramienta.
    // Se registra como saliente para sincronizar el inbox; NO ejecuta IA.
    if (msg.outbound) {
      await store.appendMsg(accId, agentId, convId, {
        role: 'assistant', sender: 'human', senderName: 'Messenger',
        content: msg.text || '', ts: Date.now(),
        providerMsgId: msg.messageId, channel: 'messenger', channelId: channel.id,
        ...(msg.internalMedia ? { mediaId: msg.internalMedia.mediaId, kind: msg.internalMedia.kind, mime: msg.internalMedia.mime, filename: msg.internalMedia.filename, sizeBytes: msg.internalMedia.sizeBytes } : {}),
      })
      continue
    }

    // Audio → transcripción automática
    await transcribeIfAudio(accId, agentId, convId, msg)

    await store.appendMsg(accId, agentId, convId, {
      role: 'user', sender: 'user',
      senderName: msg.senderName || `FB #${(msg.senderId || '').slice(-4)}`,
      content: msg.text || '',
      ts: Date.now(),
      providerMsgId: msg.messageId,
      channel: 'messenger', channelId: channel.id,
      ...(msg.internalMedia ? {
        mediaId: msg.internalMedia.mediaId, kind: msg.internalMedia.kind,
        mime: msg.internalMedia.mime, filename: msg.internalMedia.filename, sizeBytes: msg.internalMedia.sizeBytes,
      } : {}),
    })

    if (!(await aiActive(accId, agentId, convId))) continue

    const fbOutbound = async (text, meta) => {
      // Botón con enlace → template de botón nativo de Messenger.
      if (meta?.calendar?.url) {
        try {
          return await sendMessengerButtons({ pageId: channel.config.pageId, pageAccessToken: channel.config.pageAccessToken, recipientId: msg.senderId, text: meta.calendar.message || text, buttons: [{ type: 'web_url', url: meta.calendar.url, title: (meta.calendar.buttonText || 'Agendar').slice(0, 20) }] })
        } catch (e) {
          console.warn('[FB botones] falló, fallback a texto:', e.message)
          const t = `${meta.calendar.message ? meta.calendar.message + '\n' : ''}${meta.calendar.url}`
          return await sendMessengerText({ pageId: channel.config.pageId, pageAccessToken: channel.config.pageAccessToken, recipientId: msg.senderId, text: t })
        }
      }
      const body = meta?.media?.url ? `${text ? text + '\n' : ''}${meta.media.url}` : text
      if (body) return await sendMessengerText({ pageId: channel.config.pageId, pageAccessToken: channel.config.pageAccessToken, recipientId: msg.senderId, text: body })
    }
    const _returningNotice = channel?.config?.returningNotice || ''
    const doRun = async (latest) => {
      const m = latest || msg.text
      if (agent.fallbackFlowId) {
        await engine.executeFlow({
          flowId: agent.fallbackFlowId, accId, agId: agentId, convId,
          triggerContext: { message: m, _lastUserMessage: m, _returningNotice },
          outbound: fbOutbound,
        })
      } else {
        await engine.runTrigger({ trigger: 'keyword', accId, agId: agentId, convId, context: { message: m, _returningNotice }, outbound: fbOutbound })
      }
    }
    if (agent.interruptEnabled === false) { if (engine.isRunning(convId)) continue; await doRun(msg.text) }
    else await runWithInterrupt(accId, agentId, convId, doRun)
  }
}

// ─── Instagram ─────────────────────────────────────────────────────────────────
async function processInstagram(accId, agentId, body) {
  const messages = parseInstagramWebhook(body)
  const { agent } = await getAgent(accId, agentId)
  if (!agent) { console.warn('[flow/process] IG agente no encontrado:', agentId); return }

  for (const msg of messages) {
    if (!msg.text && !msg.internalMedia) continue
    if (alreadyProcessed(msg.messageId)) { console.log('[flow/process] IG duplicado ignorado:', msg.messageId); continue }

    const channel = (agent.channels || []).find(
      ch => ch.type === 'instagram' && ch.status === 'connected' && ch.config?.igAccountId === msg.igAccountId
    )
    if (!channel) { console.warn('[flow/process] Canal Instagram no encontrado:', msg.igAccountId); continue }

    const perfilIg = await metaProfile.fetchProfile(msg.senderId, channel.config?.pageAccessToken, "instagram")
    const nombreIg = msg.senderName || perfilIg?.name || ""
    const convId = await store.createOrGetInstagramConvo(accId, agentId, msg.senderId, nombreIg, channel.id, metaOrigin(msg.referral))
    await upgradeGuestName(convId, nombreIg, perfilIg?.photo)

    if (await store.messageExistsByProviderId(convId, msg.messageId)) {
      console.log('[flow/process] IG ya procesado en DB:', msg.messageId); continue
    }

    // SALIENTE (echo): lo envió el negocio desde la app de Instagram u otra herramienta.
    // Se registra en el inbox como saliente para mantener el hilo sincronizado; NO ejecuta IA.
    if (msg.outbound) {
      await store.appendMsg(accId, agentId, convId, {
        role: 'assistant', sender: 'human', senderName: 'Instagram',
        content: msg.text || '', ts: Date.now(),
        providerMsgId: msg.messageId, channel: 'instagram', channelId: channel.id,
        ...(msg.internalMedia ? { mediaId: msg.internalMedia.mediaId, kind: msg.internalMedia.kind, mime: msg.internalMedia.mime, filename: msg.internalMedia.filename, sizeBytes: msg.internalMedia.sizeBytes } : {}),
      })
      continue
    }

    // Audio → transcripción automática
    await transcribeIfAudio(accId, agentId, convId, msg)

    await store.appendMsg(accId, agentId, convId, {
      role: 'user', sender: 'user',
      senderName: msg.senderName || `IG #${(msg.senderId || '').slice(-4)}`,
      content: msg.text || '',
      ts: Date.now(),
      providerMsgId: msg.messageId,
      channel: 'instagram', channelId: channel.id,
      ...(msg.internalMedia ? {
        mediaId: msg.internalMedia.mediaId, kind: msg.internalMedia.kind,
        mime: msg.internalMedia.mime, filename: msg.internalMedia.filename, sizeBytes: msg.internalMedia.sizeBytes,
      } : {}),
    })

    if (!(await aiActive(accId, agentId, convId))) continue

    const igOutbound = async (text, meta) => {
      const body = meta?.media?.url ? `${text ? text + '\n' : ''}${meta.media.url}` : text
      if (body) return await sendInstagramText({ igAccountId: channel.config.igAccountId, pageAccessToken: channel.config.pageAccessToken, recipientId: msg.senderId, text: body })
    }
    const _returningNotice = channel?.config?.returningNotice || ''
    const doRun = async (latest) => {
      const m = latest || msg.text
      if (agent.fallbackFlowId) {
        await engine.executeFlow({
          flowId: agent.fallbackFlowId, accId, agId: agentId, convId,
          triggerContext: { message: m, _lastUserMessage: m, _returningNotice },
          outbound: igOutbound,
        })
      } else {
        await engine.runTrigger({ trigger: 'keyword', accId, agId: agentId, convId, context: { message: m, _returningNotice }, outbound: igOutbound })
      }
    }
    if (agent.interruptEnabled === false) { if (engine.isRunning(convId)) continue; await doRun(msg.text) }
    else await runWithInterrupt(accId, agentId, convId, doRun)
  }
}

module.exports = { processWhatsApp, processMessenger, processInstagram }
