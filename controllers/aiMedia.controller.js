'use strict'
/**
 * Endpoints de IA sobre media — los consume el motor de flujos del NAVEGADOR
 * (pruebas/webchat). En el servidor (canales) se llama al servicio directamente.
 *   POST /api/accounts/:accId/ai/transcribe       { mediaId }            → { text }
 *   POST /api/accounts/:accId/ai/transcribe-blob  { dataBase64, mime }   → { text }
 *   POST /api/accounts/:accId/ai/analyze-media   { mediaId, model, prompt } → { text }
 */

const mediaAI = require('../services/mediaAI')

const transcribe = async (req, res) => {
  const { accId } = req.params
  const { mediaId, model, language } = req.body || {}
  if (!mediaId) return res.status(400).json({ error: 'mediaId requerido' })
  try {
    const text = await mediaAI.transcribeMedia(accId, mediaId, { model, language })
    res.json({ ok: true, text })
  } catch (e) {
    res.status(502).json({ error: e.message || 'Error al transcribir' })
  }
}

// Transcribe un audio AÚN NO ENVIADO (vista previa del asesor): recibe los bytes
// en base64 y no persiste nada. Así el asesor ve la transcripción antes de enviar.
const transcribeBlob = async (req, res) => {
  const { accId } = req.params
  const { dataBase64, mime, filename, model, language } = req.body || {}
  if (!dataBase64) return res.status(400).json({ error: 'dataBase64 requerido' })
  try {
    const buf = Buffer.from(String(dataBase64), 'base64')
    if (!buf.length) return res.status(400).json({ error: 'Audio vacío' })
    const text = await mediaAI.transcribeBuffer(accId, buf, { mime, filename, model, language })
    res.json({ ok: true, text })
  } catch (e) {
    res.status(502).json({ error: e.message || 'Error al transcribir' })
  }
}

const analyzeMedia = async (req, res) => {
  const { accId } = req.params
  const { mediaId, model, prompt } = req.body || {}
  if (!mediaId) return res.status(400).json({ error: 'mediaId requerido' })
  try {
    const text = await mediaAI.analyzeMedia(accId, mediaId, { model, prompt })
    res.json({ ok: true, text })
  } catch (e) {
    res.status(502).json({ error: e.message || 'Error al analizar media' })
  }
}

module.exports = { transcribe, transcribeBlob, analyzeMedia }
