'use strict'
/**
 * Meta send/parse service (backend port) — envío y parseo de mensajes de
 * WhatsApp Cloud API, Messenger e Instagram vía Graph API v19. Usa fetch nativo.
 */

const GRAPH_VERSION = 'v19.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

// ─── WhatsApp ──────────────────────────────────────────────────────────────────
async function sendWhatsAppText({ phoneNumberId, accessToken, to, text }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'text', text: { preview_url: false, body: text },
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${res.status}`)
  }
  return res.json()
}

// Envía un mensaje multimedia (imagen/audio/video/documento) por URL.
async function sendWhatsAppMedia({ phoneNumberId, accessToken, to, kind, link, caption, filename }) {
  const type = kind === 'file' ? 'document' : (kind || 'image')
  const mediaObj = { link }
  // audio no admite caption; el resto sí
  if (caption && type !== 'audio') mediaObj.caption = caption
  if (type === 'document' && filename) mediaObj.filename = filename
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type, [type]: mediaObj }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${res.status}`)
  }
  return res.json()
}

// Envía una plantilla HSM aprobada por Meta.
async function sendWhatsAppTemplate({ phoneNumberId, accessToken, to, templateName, languageCode = 'es', components = [] }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: templateName, language: { code: languageCode }, components: components || [] },
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${res.status}`)
  }
  return res.json()
}

// Lista las plantillas de mensaje de un WhatsApp Business Account (WABA).
async function listWhatsAppTemplates({ businessAccountId, accessToken }) {
  const url = `${GRAPH_BASE}/${businessAccountId}/message_templates?fields=name,status,language,category,components&limit=200`
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${res.status}`)
  }
  const data = await res.json()
  return data?.data || []
}

function parseWhatsAppWebhook(body) {
  const results = []
  try {
    const entry = body?.entry?.[0]
    const changes = entry?.changes || []
    for (const change of changes) {
      if (change.field !== 'messages') continue
      const value = change.value
      const messages = value?.messages || []
      const contacts = value?.contacts || []
      const metadata = value?.metadata || {}
      for (const msg of messages) {
        const contact = contacts.find(c => c.wa_id === msg.from)
        const mediaCaption = msg.image?.caption || msg.video?.caption || msg.document?.caption || ''
        results.push({
          type: msg.type,
          from: msg.from,
          fromName: contact?.profile?.name || msg.from,
          to: metadata.display_phone_number,
          phoneNumberId: metadata.phone_number_id,
          messageId: msg.id,
          timestamp: msg.timestamp,
          text: msg.text?.body || mediaCaption || '',
          metaMediaId: msg.image?.id || msg.audio?.id || msg.document?.id || msg.video?.id || msg.sticker?.id,
          mediaCaption,
          documentName: msg.document?.filename || '',
          internalMedia: msg._internalMedia || null,
        })
      }
    }
  } catch (e) {
    console.error('[parseWhatsAppWebhook]', e)
  }
  return results
}

// ─── Messenger ─────────────────────────────────────────────────────────────────
async function sendMessengerText({ pageId, pageAccessToken, recipientId, text }) {
  const res = await fetch(`${GRAPH_BASE}/me/messages?access_token=${pageAccessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`[Messenger] ${err?.error?.message || `HTTP ${res.status}`}`)
  }
  return res.json()
}

function parseMessengerWebhook(body) {
  const messages = []
  for (const entry of body?.entry || []) {
    for (const event of entry?.messaging || []) {
      const text = event.message?.text || ''
      const attachments = event.message?.attachments || []
      const enriched = attachments.find(a => a._internalMedia)?._internalMedia || null
      if (!text && !enriched) continue
      messages.push({
        senderId: event.sender?.id,
        senderName: event.sender?.name || null,
        text,
        messageId: event.message?.mid,
        pageId: entry.id,
        timestamp: event.timestamp,
        internalMedia: enriched,
      })
    }
  }
  return messages
}

// ─── Instagram ─────────────────────────────────────────────────────────────────
async function sendInstagramText({ igAccountId, pageAccessToken, recipientId, text }) {
  const res = await fetch(`${GRAPH_BASE}/me/messages?access_token=${pageAccessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`[Instagram] ${err?.error?.message || `HTTP ${res.status}`}`)
  }
  return res.json()
}

function parseInstagramWebhook(body) {
  const messages = []
  for (const entry of body?.entry || []) {
    for (const event of entry?.messaging || []) {
      const text = event.message?.text || ''
      const attachments = event.message?.attachments || []
      const enriched = attachments.find(a => a._internalMedia)?._internalMedia || null
      if (!text && !enriched) continue
      messages.push({
        senderId: event.sender?.id,
        senderName: event.sender?.name || null,
        text,
        messageId: event.message?.mid,
        igAccountId: entry.id,
        timestamp: event.timestamp,
        internalMedia: enriched,
      })
    }
    for (const change of entry?.changes || []) {
      if (change.field !== 'messages') continue
      const value = change.value
      if (!value?.messages) continue
      for (const msg of value.messages) {
        const contact = (value.contacts || []).find(c => c.wa_id === msg.from)
        const text = msg.text?.body || msg.text || ''
        const internalMedia = msg._internalMedia || null
        if (!text && !internalMedia) continue
        messages.push({
          senderId: msg.from,
          senderName: contact?.profile?.name || null,
          text,
          messageId: msg.id,
          igAccountId: value.metadata?.phone_number_id || entry.id,
          timestamp: msg.timestamp,
          internalMedia,
        })
      }
    }
  }
  return messages
}

module.exports = {
  sendWhatsAppText, sendWhatsAppMedia, parseWhatsAppWebhook,
  sendWhatsAppTemplate, listWhatsAppTemplates,
  sendMessengerText, parseMessengerWebhook,
  sendInstagramText, parseInstagramWebhook,
}
