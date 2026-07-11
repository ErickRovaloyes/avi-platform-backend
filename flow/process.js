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

// Decide si el flujo debe correr: IA activa y sin ejecución en curso.
async function shouldRun(accId, agentId, convId) {
  if (engine.isRunning(convId)) return false
  const convos = await store.readConvos(accId, agentId)
  const conv = (convos || []).find(c => c.id === convId)
  if (conv?.aiEnabled === false) return false
  return true
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

    if (!(await shouldRun(accId, agentId, convId))) continue

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
    if (agent.fallbackFlowId) {
      await engine.executeFlow({
        flowId: agent.fallbackFlowId, accId, agId: agentId, convId,
        triggerContext: { message: msg.text, _lastUserMessage: msg.text, ...quotedCtx },
        outbound: waOutbound,
      })
    } else {
      await engine.runTrigger({ trigger: 'keyword', accId, agId: agentId, convId, context: { message: msg.text, ...quotedCtx }, outbound: waOutbound })
    }
  }
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

    const convId = await store.createOrGetMessengerConvo(accId, agentId, msg.senderId, msg.senderName, channel.id)

    if (await store.messageExistsByProviderId(convId, msg.messageId)) {
      console.log('[flow/process] FB ya procesado en DB:', msg.messageId); continue
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

    if (!(await shouldRun(accId, agentId, convId))) continue

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
    if (agent.fallbackFlowId) {
      await engine.executeFlow({
        flowId: agent.fallbackFlowId, accId, agId: agentId, convId,
        triggerContext: { message: msg.text, _lastUserMessage: msg.text },
        outbound: fbOutbound,
      })
    } else {
      await engine.runTrigger({ trigger: 'keyword', accId, agId: agentId, convId, context: { message: msg.text }, outbound: fbOutbound })
    }
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

    const convId = await store.createOrGetInstagramConvo(accId, agentId, msg.senderId, msg.senderName, channel.id)

    if (await store.messageExistsByProviderId(convId, msg.messageId)) {
      console.log('[flow/process] IG ya procesado en DB:', msg.messageId); continue
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

    if (!(await shouldRun(accId, agentId, convId))) continue

    const igOutbound = async (text, meta) => {
      const body = meta?.media?.url ? `${text ? text + '\n' : ''}${meta.media.url}` : text
      if (body) return await sendInstagramText({ igAccountId: channel.config.igAccountId, pageAccessToken: channel.config.pageAccessToken, recipientId: msg.senderId, text: body })
    }
    if (agent.fallbackFlowId) {
      await engine.executeFlow({
        flowId: agent.fallbackFlowId, accId, agId: agentId, convId,
        triggerContext: { message: msg.text, _lastUserMessage: msg.text },
        outbound: igOutbound,
      })
    } else {
      await engine.runTrigger({ trigger: 'keyword', accId, agId: agentId, convId, context: { message: msg.text }, outbound: igOutbound })
    }
  }
}

module.exports = { processWhatsApp, processMessenger, processInstagram }
