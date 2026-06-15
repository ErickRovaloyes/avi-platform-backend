'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')
const {
  uploadWhatsAppMedia, sendWhatsAppMediaMessage,
  uploadFacebookAttachment, sendMessengerMediaMessage,
  sendInstagramMediaMessage,
} = require('../services/metaMedia')
const { convertWebmToOgg } = require('../services/audioConvert')

// Map a mime type to one of our 4 kinds.
function detectKind(mime, filename = '') {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  // Fallback by extension when mime is generic (browser sometimes sends application/octet-stream)
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (['jpg','jpeg','png','gif','webp','heic','heif','svg'].includes(ext)) return 'image'
  if (['mp4','webm','mov','avi','mkv','m4v'].includes(ext))                return 'video'
  if (['mp3','ogg','wav','m4a','aac','opus','webm'].includes(ext))         return 'audio'
  return 'file'
}

// Server-side helper used by webhooks (WhatsApp/Messenger/Instagram) to store
// a media binary received via the channel's media API. Returns the new media row id.
async function storeMediaInternal({ accId, convId, messageId = null, buffer, mime, filename, kind, ts }) {
  const id = 'med_' + uid()
  const actualKind = kind || detectKind(mime, filename)
  const dataB64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : String(buffer)
  const sizeBytes = Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(dataB64, 'base64')
  await pool.query(
    `INSERT INTO media (id, account_id, conversation_id, message_id, kind, mime_type, filename, size_bytes, data_base64, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, accId, convId, messageId, actualKind, mime || 'application/octet-stream',
     filename || ('media_' + Date.now()), sizeBytes, dataB64, ts || Date.now()]
  )
  return { id, kind: actualKind, mime: mime || 'application/octet-stream', filename, sizeBytes }
}

// ── HTTP: upload a media file attached to a conversation ────────────────────
// POST /api/conversations/:accId/:agId/:convId/media
// Multipart: { file: <binary> }
// Optional body fields: kind, filename
// Side effect: creates a corresponding `messages` row so the media appears in
// the conversation thread (sender comes from req.body.sender, defaults to 'human').
const uploadMedia = async (req, res) => {
  const { accId, agId, convId } = req.params
  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' })
  const sender     = (req.body.sender || 'human').toLowerCase()
  const senderName = req.body.senderName || ''
  const caption    = req.body.caption || ''

  try {
    // Enforce the platform-wide max size set by the super admin.
    // Multer accepts up to 100 MB hardcap (see media.routes.js); the effective limit
    // is whatever the super admin configured, defaulting to 30 MB.
    const [[pf]] = await pool.query('SELECT media_max_size_mb FROM platform_settings WHERE id=1')
    const maxBytes = (pf?.media_max_size_mb || 30) * 1024 * 1024
    if (req.file.size > maxBytes) {
      return res.status(413).json({ error: `Archivo excede el límite de ${pf?.media_max_size_mb || 30} MB configurado por el administrador` })
    }
    const mime     = req.file.mimetype || 'application/octet-stream'
    const filename = req.file.originalname || ('media_' + Date.now())
    const kind     = detectKind(mime, filename)
    const ts       = Date.now()

    // 1) store media
    const messageId = 'msg_' + uid()
    const media = await storeMediaInternal({
      accId, convId, messageId,
      buffer: req.file.buffer, mime, filename, kind, ts,
    })

    // 2) create the message row that points to the media
    const metadata = {
      mediaId: media.id,
      kind: media.kind,
      mime: media.mime,
      filename,
      sizeBytes: media.sizeBytes,
      ...(senderName ? { senderName } : {}),
    }
    await pool.query(
      'INSERT INTO messages (id,conversation_id,sender,content,metadata,ts) VALUES (?,?,?,?,?,?)',
      [messageId, convId, sender, caption || '', JSON.stringify(metadata), ts]
    )

    // 2.5) Auto-transcripción de notas de voz del usuario. La transcripción pasa a
    //      ser el contenido del mensaje y el {{_lastUserMessage}} del flujo.
    let transcription = null
    if (sender === 'user' && media.kind === 'audio') {
      try {
        const mediaAI = require('../services/mediaAI')
        transcription = await mediaAI.transcribeMedia(accId, media.id)
        if (transcription) {
          metadata.transcription = transcription
          await pool.query('UPDATE messages SET content=?, metadata=? WHERE id=?', [transcription, JSON.stringify(metadata), messageId])
          const [[cv]] = await pool.query('SELECT local_vars FROM conversations WHERE id=? AND account_id=?', [convId, accId])
          const lv = parseJ(cv?.local_vars, {})
          lv._lastUserMessage = transcription
          await pool.query('UPDATE conversations SET local_vars=? WHERE id=? AND account_id=?', [JSON.stringify(lv), convId, accId])
        }
      } catch (e) { console.warn('[transcribe]', e.message) }
    }

    // 3) bump preview + updated_at on the conversation (same as appendMessage)
    const effectiveContent = transcription || caption || ''
    const previewIcon = kind === 'image' ? '🖼' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎤' : '📎'
    const preview = transcription
      ? `🎤 ${transcription}`.slice(0, 60)
      : ((caption ? caption.slice(0, 50) + ' ' : '') + `${previewIcon} ${filename}`).slice(0, 60)
    const sets = ['preview=?', 'updated_at=?']
    const vals = [preview, ts]
    if (sender === 'user') sets.push('unread=1')
    vals.push(convId, accId)
    await pool.query(`UPDATE conversations SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)

    // 4) Outbound to external channels — when the asesor sends media to a
    //    conversation that originated from WhatsApp/Messenger/Instagram, push
    //    the file out through the corresponding Graph API.
    let outWamid = null, outStatus = null
    if (sender !== 'user') {
      try {
        const [[c]] = await pool.query(
          'SELECT channel_type, channel_id, wa_from, messenger_from, ig_from FROM conversations WHERE id=? AND account_id=?',
          [convId, accId]
        )
        if (c && ['whatsapp', 'messenger', 'instagram'].includes(c.channel_type)) {
          // Lookup the channel config on the agent
          const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
          const channels = parseJ(ag?.channels, [])
          const ch = channels.find(x => x.id === c.channel_id) || channels.find(x => x.type === c.channel_type)
          const cfg = ch?.config || {}
          if (c.channel_type === 'whatsapp' && cfg.phoneNumberId && cfg.accessToken && c.wa_from) {
            // WhatsApp no acepta audio/webm (lo que graba el navegador): lo
            // convertimos a ogg/opus antes de subirlo.
            let upBuffer = req.file.buffer, upMime = mime, upFilename = filename
            if (media.kind === 'audio' && /webm/i.test(mime)) {
              try {
                upBuffer = await convertWebmToOgg(req.file.buffer)
                upMime = 'audio/ogg'
                upFilename = (filename || 'audio').replace(/\.[^.]+$/, '') + '.ogg'
              } catch (e) { console.warn('[audio convert]', e.message) }
            }
            const waMediaId = await uploadWhatsAppMedia({
              phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken,
              buffer: upBuffer, mime: upMime, filename: upFilename,
            })
            const rWa = await sendWhatsAppMediaMessage({
              phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken,
              to: c.wa_from, kind: media.kind, mediaId: waMediaId,
              caption: caption || undefined, filename: upFilename,
            })
            outWamid = rWa?.messages?.[0]?.id || null; outStatus = 'sent'
          } else if (c.channel_type === 'messenger' && cfg.pageAccessToken && c.messenger_from) {
            const attId = await uploadFacebookAttachment({
              pageId: cfg.pageId, pageAccessToken: cfg.pageAccessToken,
              buffer: req.file.buffer, mime, kind: media.kind, filename,
            })
            await sendMessengerMediaMessage({
              pageId: cfg.pageId, pageAccessToken: cfg.pageAccessToken,
              recipientId: c.messenger_from, kind: media.kind, attachmentId: attId,
            })
            outStatus = 'sent'
          } else if (c.channel_type === 'instagram' && cfg.pageAccessToken && c.ig_from) {
            // Instagram can't upload attachments separately — must use a public URL.
            // We expose the raw media bytes through our own public endpoint.
            const base = process.env.PUBLIC_URL || process.env.BASE_URL || ''
            const url  = `${base}/api/media/${accId}/${media.id}/raw`
            await sendInstagramMediaMessage({
              igAccountId: cfg.igAccountId, pageAccessToken: cfg.pageAccessToken,
              recipientId: c.ig_from, kind: media.kind, mediaUrl: url,
            })
            outStatus = 'sent'
          }
        }
      } catch (e) {
        // Outbound failure shouldn't block the local message — log and continue.
        outStatus = 'failed'
        metadata.sendError = e.message
        console.warn('[media outbound]', e.message)
      }
    }

    // Persist the delivery state + provider id so the chat shows ✓/✓✓ and the
    // status webhooks (delivered/read) can match this audio/media by waMessageId.
    if (outStatus) {
      metadata.status = outStatus
      if (outWamid) metadata.waMessageId = outWamid
      await pool.query('UPDATE messages SET metadata=? WHERE id=?', [JSON.stringify(metadata), messageId])
      socket.emit(accId, 'message:status', { accId, agId, convId, messageId, status: outStatus })
    }

    // 5) emit socket events so all listeners refresh
    const msg = {
      id: messageId, sender, role: sender === 'user' ? 'user' : 'assistant',
      content: effectiveContent, ts, ...metadata,
    }
    socket.emit(accId, 'message:new', { accId, agId, convId, message: msg })
    socket.emitToConv(convId, 'message:new', { convId, message: msg })

    res.json({ ok: true, id: messageId, mediaId: media.id, ts, kind: media.kind, mime: media.mime, filename, sizeBytes: media.sizeBytes, transcription })
  } catch (err) {
    console.error('[UPLOAD MEDIA]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

// ── HTTP: generic upload (team chat / support — no conversation thread) ──────
// POST /api/media/:accId/upload   Multipart { file }, optional body { context }
// Stores the binary in the media table and returns its metadata. The caller is
// responsible for attaching the returned mediaId to its own message record.
const uploadGenericMedia = async (req, res) => {
  const { accId } = req.params
  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' })
  try {
    const [[pf]] = await pool.query('SELECT media_max_size_mb FROM platform_settings WHERE id=1')
    const maxBytes = (pf?.media_max_size_mb || 30) * 1024 * 1024
    if (req.file.size > maxBytes) {
      return res.status(413).json({ error: `Archivo excede el límite de ${pf?.media_max_size_mb || 30} MB` })
    }
    const mime     = req.file.mimetype || 'application/octet-stream'
    const filename = req.file.originalname || ('media_' + Date.now())
    const kind     = detectKind(mime, filename)
    const context  = (req.body.context || 'chat').slice(0, 80)
    const media = await storeMediaInternal({
      accId, convId: context, messageId: null,
      buffer: req.file.buffer, mime, filename, kind, ts: Date.now(),
    })
    res.json({ mediaId: media.id, kind: media.kind, mime: media.mime, filename: media.filename, sizeBytes: media.sizeBytes })
  } catch (err) {
    console.error('[UPLOAD GENERIC MEDIA]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

// ── HTTP: download (returns the base64 + metadata) ──────────────────────────
// GET /api/media/:accId/:mediaId
// Public (no auth) so it can also serve <img>/<audio>/<video> tags in the
// public webchat. The IDs are unguessable.
const getMedia = async (req, res) => {
  const { accId, mediaId } = req.params
  try {
    const [[m]] = await pool.query(
      'SELECT id, kind, mime_type, filename, size_bytes, data_base64, ts FROM media WHERE id=? AND account_id=?',
      [mediaId, accId]
    )
    if (!m) return res.status(404).json({ error: 'Media no encontrada' })
    res.json({
      id: m.id, kind: m.kind, mime: m.mime_type, filename: m.filename,
      sizeBytes: m.size_bytes, ts: m.ts,
      dataUrl: `data:${m.mime_type};base64,${m.data_base64}`,
    })
  } catch (err) {
    console.error('[GET MEDIA]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// ── HTTP: stream raw bytes (so browsers can use the URL directly in <img src>) ─
// GET /api/media/:accId/:mediaId/raw
const getMediaRaw = async (req, res) => {
  const { accId, mediaId } = req.params
  try {
    const [[m]] = await pool.query(
      'SELECT mime_type, filename, data_base64 FROM media WHERE id=? AND account_id=?',
      [mediaId, accId]
    )
    if (!m) return res.status(404).send('not found')
    const buf = Buffer.from(m.data_base64, 'base64')
    res.set('Content-Type', m.mime_type || 'application/octet-stream')
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.set('Content-Disposition', `inline; filename="${(m.filename || 'file').replace(/"/g, '')}"`)
    res.send(buf)
  } catch (err) {
    console.error('[GET MEDIA RAW]', err)
    res.status(500).send('error')
  }
}

module.exports = { uploadMedia, uploadGenericMedia, getMedia, getMediaRaw, storeMediaInternal, detectKind }
