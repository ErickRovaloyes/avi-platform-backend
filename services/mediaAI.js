'use strict'
/**
 * Media AI — transcripción de audio (Whisper) y análisis de imágenes/archivos
 * (modelos de visión / texto). Usa la API Key de OpenAI efectiva de la cuenta
 * (clave propia o la del platform por defecto, vía loadPublicAccount).
 *
 * Centralizado aquí para que lo usen IGUAL:
 *   - el subidor de media (auto-transcripción de audios del usuario)
 *   - el motor de flujos server-side (canales)
 *   - el endpoint HTTP que consume el motor del navegador (pruebas/webchat)
 */

const pool = require('../db')
const { loadPublicAccount } = require('../controllers/accounts.controller')

async function loadMedia(accId, mediaId) {
  const [[m]] = await pool.query(
    'SELECT id, kind, mime_type, filename, data_base64 FROM media WHERE id=? AND account_id=?',
    [mediaId, accId]
  )
  return m || null
}

async function getOpenAIKey(accId) {
  const acc = await loadPublicAccount(accId)
  return acc?.openaiKey || ''
}

// Modelo de transcripción configurado por el super admin (OpenAI). Deepseek NO
// ofrece transcripción de audio, por eso solo hay modelos de OpenAI.
async function getTranscriptionModel() {
  try {
    const [[r]] = await pool.query('SELECT transcription_model FROM platform_settings WHERE id=1')
    const allowed = ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe']
    return allowed.includes(r?.transcription_model) ? r.transcription_model : 'whisper-1'
  } catch { return 'whisper-1' }
}

// ── Transcripción de audio (OpenAI Whisper / gpt-4o-transcribe) ───────────────
async function transcribeMedia(accId, mediaId, { model, language } = {}) {
  const m = await loadMedia(accId, mediaId)
  if (!m) throw new Error('Audio no encontrado')
  const apiKey = await getOpenAIKey(accId)
  if (!apiKey) throw new Error('Sin API Key de OpenAI para transcribir audios')
  // Modelo: el que pase el llamador, o el configurado en el Super Panel.
  if (!model) model = await getTranscriptionModel()

  const buf = Buffer.from(m.data_base64, 'base64')
  if (!buf.length) throw new Error('El audio está vacío')

  // Whisper acepta: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm. Hay que
  // mandar un nombre de archivo con extensión válida y un mime sin "; codecs=...".
  const baseMime = String(m.mime_type || 'audio/ogg').split(';')[0].trim().toLowerCase()
  const EXT_BY_MIME = {
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/oga': 'oga', 'audio/opus': 'ogg',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'mp4', 'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/flac': 'flac', 'audio/x-flac': 'flac',
  }
  const SUPPORTED = /\.(flac|m4a|mp3|mp4|mpeg|mpga|oga|ogg|wav|webm)$/i
  const ext = EXT_BY_MIME[baseMime] || 'ogg'
  let filename = m.filename || `audio.${ext}`
  if (!SUPPORTED.test(filename)) filename = `audio.${ext}`

  const form = new FormData()
  // File conserva el nombre/extensión de forma fiable en el multipart de Node.
  const fileObj = (typeof File !== 'undefined')
    ? new File([buf], filename, { type: baseMime })
    : new Blob([buf], { type: baseMime })
  form.append('file', fileObj, filename)
  form.append('model', model)
  form.append('response_format', 'text')
  if (language) form.append('language', language)

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Whisper ${res.status}: ${(t || res.statusText).slice(0, 200)}`)
  }
  // response_format=text → cuerpo es texto plano
  const text = (await res.text()).trim()
  return text
}

// ── Llamada simple a chat completions (visión o texto) ────────────────────────
async function openaiChat(apiKey, body) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(`[OpenAI] ${errData?.error?.message || `HTTP ${res.status}`}`)
  }
  const data = await res.json()
  return (data.choices?.[0]?.message?.content || '').trim()
}

const TEXT_FILE_RE = /(text\/|json|csv|xml|javascript|html|markdown)/i
const TEXT_EXT_RE  = /\.(txt|csv|json|md|markdown|log|xml|html?|tsv|ya?ml)$/i

// ── Análisis de imagen / archivo con un modelo IA + miniprompt ────────────────
async function analyzeMedia(accId, mediaId, { model, prompt } = {}) {
  const m = await loadMedia(accId, mediaId)
  if (!m) throw new Error('Archivo no encontrado')
  const apiKey = await getOpenAIKey(accId)
  if (!apiKey) throw new Error('Sin API Key de OpenAI para analizar media')
  const finalModel = model || 'gpt-4o-mini'
  const sys = prompt && prompt.trim()
    ? prompt.trim()
    : 'Describe de forma concisa y útil el contenido para que un asistente lo entienda.'

  if (m.kind === 'image') {
    const dataUrl = `data:${m.mime_type || 'image/png'};base64,${m.data_base64}`
    const text = await openaiChat(apiKey, {
      model: finalModel,
      max_tokens: 500,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: [
          { type: 'text', text: prompt && prompt.trim() ? prompt.trim() : 'Describe esta imagen.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ],
    })
    return text
  }

  // Archivo: si es texto-decodificable lo mandamos al modelo; si es binario,
  // devolvemos una referencia con el nombre (no podemos leerlo de forma fiable).
  const isTexty = TEXT_FILE_RE.test(m.mime_type || '') || TEXT_EXT_RE.test(m.filename || '')
  if (!isTexty) {
    return `[archivo: ${m.filename || 'sin nombre'} (${m.mime_type || 'desconocido'})]`
  }
  const content = Buffer.from(m.data_base64, 'base64').toString('utf8').slice(0, 12000)
  const text = await openaiChat(apiKey, {
    model: finalModel,
    max_tokens: 600,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `${prompt && prompt.trim() ? prompt.trim() : 'Analiza este archivo'}:\n\n${content}` },
    ],
  })
  return text
}

module.exports = { transcribeMedia, analyzeMedia, loadMedia }
