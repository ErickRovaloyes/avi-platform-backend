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
  parseWhatsAppWebhook, sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppRead,
  parseMessengerWebhook, sendMessengerText,
  parseInstagramWebhook, sendInstagramText,
} = require('../services/metaSend')

// Transcribe la nota de voz del usuario (si la hay) y usa la transcripción como
// texto del mensaje → así se persiste como contenido y queda en {{_lastUserMessage}}.
async function transcribeIfAudio(accId, msg) {
  if (msg.text || msg.internalMedia?.kind !== 'audio') return msg.text || ''
  try {
    const text = await mediaAI.transcribeMedia(accId, msg.internalMedia.mediaId)
    if (text) msg.text = text
  } catch (e) { console.warn('[flow/process] transcripción', e.message) }
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

    const convId = await store.createOrGetWhatsAppConvo(accId, agentId, msg.from, msg.fromName, channel?.id)

    // Idempotencia persistente: si este waMessageId ya se guardó, no reprocesar.
    if (await store.messageExistsByProviderId(convId, msg.messageId)) {
      console.log('[flow/process] WA ya procesado en DB:', msg.messageId); continue
    }

    // Audio → transcripción automática (queda como texto del mensaje)
    await transcribeIfAudio(accId, msg)

    await store.appendMsg(accId, agentId, convId, {
      role: 'user', sender: 'user',
      senderName: msg.fromName || msg.from,
      content: msg.text || msg.mediaCaption || '',
      ts: Date.now(),
      waMessageId: msg.messageId,
      channel: 'whatsapp', channelId: channel?.id,
      ...(msg.internalMedia ? {
        mediaId: msg.internalMedia.mediaId, kind: msg.internalMedia.kind,
        mime: msg.internalMedia.mime, filename: msg.internalMedia.filename, sizeBytes: msg.internalMedia.sizeBytes,
      } : {}),
    })

    if (!(await shouldRun(accId, agentId, convId))) continue

    // Indicador "escribiendo…" mientras el flujo genera la respuesta (y marca leído).
    if (channel?.config?.phoneNumberId && channel?.config?.accessToken && msg.messageId) {
      sendWhatsAppRead({ phoneNumberId: channel.config.phoneNumberId, accessToken: channel.config.accessToken, messageId: msg.messageId, typing: true }).catch(() => {})
    }

    const waOutbound = async (text, meta) => {
      const cfg = channel?.config
      if (!cfg?.phoneNumberId || !cfg?.accessToken) return
      if (meta?.media?.url) {
        return await sendWhatsAppMedia({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: msg.from, kind: meta.media.kind, link: meta.media.url, caption: meta.caption, filename: meta.media.filename })
      }
      if (text) return await sendWhatsAppText({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, to: msg.from, text })
    }
    if (agent.fallbackFlowId) {
      await engine.executeFlow({
        flowId: agent.fallbackFlowId, accId, agId: agentId, convId,
        triggerContext: { message: msg.text, _lastUserMessage: msg.text },
        outbound: waOutbound,
      })
    } else {
      await engine.runTrigger({ trigger: 'keyword', accId, agId: agentId, convId, context: { message: msg.text }, outbound: waOutbound })
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
    await transcribeIfAudio(accId, msg)

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
    await transcribeIfAudio(accId, msg)

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
