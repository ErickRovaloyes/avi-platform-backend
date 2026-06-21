'use strict'
/**
 * Meta send/parse service (backend port) — envío y parseo de mensajes de
 * WhatsApp Cloud API, Messenger e Instagram vía Graph API v19. Usa fetch nativo.
 */

const GRAPH_VERSION = 'v19.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

// ─── WhatsApp ──────────────────────────────────────────────────────────────────
async function sendWhatsAppText({ phoneNumberId, accessToken, to, text, contextMessageId }) {
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to, type: 'text', text: { preview_url: false, body: text },
  }
  // Citar (responder a) un mensaje anterior → cita nativa de WhatsApp.
  if (contextMessageId) payload.context = { message_id: contextMessageId }
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${res.status}`)
  }
  return res.json()
}

// El display_text del botón NO admite emojis ni markdown → lo limpiamos.
function sanitizeButtonLabel(s) {
  const cleaned = String(s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20)
    .trim()
  return cleaned || 'Abrir'
}

// Envía un botón interactivo "CTA URL" (botón que abre una URL). Es la forma
// nativa de WhatsApp para enviar un botón con enlace (p. ej. agendar cita).
// body.text es obligatorio (admite emojis); display_text máx 20 chars y SIN
// emojis/markdown; url debe ser absoluta (https).
async function sendWhatsAppCtaUrl({ phoneNumberId, accessToken, to, bodyText, buttonText, url }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: (bodyText && bodyText.trim()) ? bodyText.slice(0, 1024) : 'Agenda tu cita' },
        action: { name: 'cta_url', parameters: { display_text: sanitizeButtonLabel(buttonText), url } },
      },
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${res.status}`)
  }
  return res.json()
}

// Marca un mensaje entrante como leído y, opcionalmente, muestra el indicador
// "escribiendo…" al usuario (hasta 25s o hasta que se envíe un mensaje).
// No es crítico: cualquier error se ignora para no bloquear el flujo.
async function sendWhatsAppRead({ phoneNumberId, accessToken, messageId, typing = false }) {
  if (!phoneNumberId || !accessToken || !messageId) return false
  try {
    const body = { messaging_product: 'whatsapp', status: 'read', message_id: messageId }
    if (typing) body.typing_indicator = { type: 'text' }
    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch { return false }
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
          // Si el usuario respondió/citó un mensaje anterior, Meta envía context.id
          // (el wamid del mensaje citado). Lo resolveremos contra nuestra BD.
          quotedId: msg.context?.id || null,
          // Anuncio Click-to-WhatsApp (Meta): cuando el chat se inicia desde un
          // anuncio, Meta adjunta `referral` con el id del anuncio, titular, etc.
          referral: msg.referral || null,
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

// Envía un mensaje con botones (template "button") en Messenger.
// buttons: [{ type:'web_url', url, title }] (title ≤ 20 chars).
async function sendMessengerButtons({ pageId, pageAccessToken, recipientId, text, buttons }) {
  const res = await fetch(`${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: 'template', payload: { template_type: 'button', text: (text || 'Agenda tu cita').slice(0, 640), buttons } } },
    }),
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
  sendWhatsAppText, sendWhatsAppMedia, sendWhatsAppRead, sendWhatsAppCtaUrl, parseWhatsAppWebhook,
  sendWhatsAppTemplate, listWhatsAppTemplates,
  sendMessengerText, sendMessengerButtons, parseMessengerWebhook,
  sendInstagramText, parseInstagramWebhook,
}
