'use strict'

/**
 * Server-side helpers to send and receive media files for the Meta channels
 * (WhatsApp Cloud API, Messenger Send API, Instagram Messaging API).
 *
 * Node 18+ provides global fetch, FormData and Blob — no extra deps required.
 */

const GRAPH_VERSION = 'v19.0'
const GRAPH_BASE    = `https://graph.facebook.com/${GRAPH_VERSION}`

// Translate our internal kind (image/video/audio/file) into the WhatsApp message type
function waTypeForKind(kind) {
  if (kind === 'image') return 'image'
  if (kind === 'video') return 'video'
  if (kind === 'audio') return 'audio'
  if (kind === 'sticker') return 'sticker'
  return 'document'
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

// 1) Upload the binary to the WhatsApp Media endpoint, returning a media id.
async function uploadWhatsAppMedia({ phoneNumberId, accessToken, buffer, mime, filename }) {
  const fd = new FormData()
  fd.append('messaging_product', 'whatsapp')
  fd.append('type', mime || 'application/octet-stream')
  fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'media')
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: fd,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`[WA upload] ${err?.error?.message || res.status}`)
  }
  const data = await res.json()
  return data.id
}

// 2) Send a previously-uploaded media id (or a public URL) to a recipient.
async function sendWhatsAppMediaMessage({ phoneNumberId, accessToken, to, kind, mediaId, mediaUrl, caption, filename }) {
  const waType = waTypeForKind(kind)
  const payload = mediaId ? { id: mediaId } : { link: mediaUrl }
  if (caption && (waType === 'image' || waType === 'video' || waType === 'document')) payload.caption = caption
  if (filename && waType === 'document') payload.filename = filename

  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: waType,
      [waType]: payload,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`[WA send media] ${err?.error?.message || res.status}`)
  }
  return res.json()
}

// 3) Download a media payload received via webhook. Returns { buffer, mime, filename }.
async function downloadWhatsAppMedia({ accessToken, mediaId, suggestedFilename }) {
  // First call: resolve the temporary download URL (valid ~5 min).
  const meta = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  })
  if (!meta.ok) {
    const err = await meta.json().catch(() => ({}))
    throw new Error(`[WA media meta] ${err?.error?.message || meta.status}`)
  }
  const info = await meta.json()
  // Second call: fetch the binary from the resolved URL (still needs the bearer).
  const bin = await fetch(info.url, { headers: { 'Authorization': `Bearer ${accessToken}` } })
  if (!bin.ok) throw new Error(`[WA media bin] HTTP ${bin.status}`)
  const arrBuf = await bin.arrayBuffer()
  return {
    buffer: Buffer.from(arrBuf),
    mime:   info.mime_type || 'application/octet-stream',
    filename: suggestedFilename || `media_${mediaId}`,
    sizeBytes: info.file_size || arrBuf.byteLength,
    sha256: info.sha256,
  }
}

// ── Messenger ──────────────────────────────────────────────────────────────
// Messenger expects either a hosted URL or an uploaded attachment id.
// We upload the file once and reuse the attachment id for sends.

function fbTypeForKind(kind) {
  if (kind === 'image') return 'image'
  if (kind === 'video') return 'video'
  if (kind === 'audio') return 'audio'
  return 'file'
}

async function uploadFacebookAttachment({ pageId, pageAccessToken, buffer, mime, kind, filename, isReusable = true }) {
  const fbType = fbTypeForKind(kind)
  const fd = new FormData()
  fd.append('message', JSON.stringify({ attachment: { type: fbType, payload: { is_reusable: isReusable } } }))
  fd.append('filedata', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'attachment')
  const res = await fetch(`${GRAPH_BASE}/me/message_attachments?access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: 'POST', body: fd,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`[FB upload] ${err?.error?.message || res.status}`)
  }
  const data = await res.json()
  return data.attachment_id
}

async function sendMessengerMediaMessage({ pageId, pageAccessToken, recipientId, kind, attachmentId, mediaUrl }) {
  const fbType = fbTypeForKind(kind)
  const payload = attachmentId
    ? { attachment_id: attachmentId }
    : { url: mediaUrl, is_reusable: true }
  const res = await fetch(`${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: fbType, payload } },
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`[FB send] ${err?.error?.message || res.status}`)
  }
  return res.json()
}

// Messenger webhook delivers media as public URLs in `message.attachments[].payload.url`.
// We just need to download them with a plain GET — no token required.
async function downloadFromUrl(url, suggestedFilename) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`[download] HTTP ${res.status}`)
  const arrBuf = await res.arrayBuffer()
  const mime = res.headers.get('content-type') || 'application/octet-stream'
  return {
    buffer: Buffer.from(arrBuf),
    mime,
    filename: suggestedFilename || (url.split('/').pop() || 'media').split('?')[0],
    sizeBytes: arrBuf.byteLength,
  }
}

// ── Instagram ──────────────────────────────────────────────────────────────
// Instagram Messaging API mirrors Messenger. Sending uses the IG user account_id
// scoped endpoint, but for replies it's commonly `me/messages` with the proper page token.

async function sendInstagramMediaMessage({ igAccountId, pageAccessToken, recipientId, kind, attachmentId, mediaUrl }) {
  const fbType = fbTypeForKind(kind)
  const payload = attachmentId
    ? { attachment_id: attachmentId }
    : { url: mediaUrl, is_reusable: true }
  const res = await fetch(`${GRAPH_BASE}/${igAccountId}/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: fbType, payload } },
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`[IG send] ${err?.error?.message || res.status}`)
  }
  return res.json()
}

module.exports = {
  // WhatsApp
  uploadWhatsAppMedia, sendWhatsAppMediaMessage, downloadWhatsAppMedia,
  // Messenger
  uploadFacebookAttachment, sendMessengerMediaMessage, downloadFromUrl,
  // Instagram
  sendInstagramMediaMessage,
  // Helpers
  waTypeForKind, fbTypeForKind,
}
