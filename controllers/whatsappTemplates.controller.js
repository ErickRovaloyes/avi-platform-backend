'use strict'
/**
 * WhatsApp message templates (HSM) — listar las plantillas aprobadas por Meta y
 * enviarlas desde el inbox a un cliente. El envío real pasa por el servidor
 * (coherente con el resto de la mensajería saliente) y se persiste en la
 * conversación para que quede en el historial del inbox.
 */

const pool = require('../db')
const { parseJ } = require('../utils')
const { sendWhatsAppTemplate, listWhatsAppTemplates } = require('../services/metaSend')
const store = require('../flow/store')

// Resuelve la config del canal WhatsApp de un agente. Si se pasa channelId,
// busca ese canal; si no, toma el primer canal whatsapp conectado.
async function resolveWhatsAppChannel(accId, agentId, channelId) {
  const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agentId, accId])
  const channels = parseJ(ag?.channels, [])
  const wa = channels.filter(c => c.type === 'whatsapp')
  const chosen = (channelId && wa.find(c => c.id === channelId))
    || wa.find(c => c.status === 'connected')
    || wa[0]
  return chosen || null
}

// GET /api/whatsapp/:accId/:agentId/templates?channelId=
const list = async (req, res) => {
  const { accId, agentId } = req.params
  const { channelId } = req.query
  try {
    const channel = await resolveWhatsAppChannel(accId, agentId, channelId)
    const cfg = channel?.config || {}
    if (!cfg.businessAccountId) {
      return res.status(400).json({ error: 'Falta el Business Account ID en la configuración del canal de WhatsApp.' })
    }
    if (!cfg.accessToken) {
      return res.status(400).json({ error: 'Falta el Access Token en la configuración del canal de WhatsApp.' })
    }
    const all = await listWhatsAppTemplates({ businessAccountId: cfg.businessAccountId, accessToken: cfg.accessToken })
    // Solo plantillas aprobadas y utilizables
    const templates = all
      .filter(t => (t.status || '').toUpperCase() === 'APPROVED')
      .map(t => ({ name: t.name, language: t.language, category: t.category, components: t.components || [] }))
    res.json({ channelId: channel.id, templates })
  } catch (err) {
    console.error('[WA TEMPLATES list]', err)
    res.status(502).json({ error: err.message || 'No se pudieron obtener las plantillas' })
  }
}

// GET /api/whatsapp/:accId/:agentId/templates/all?channelId=
// Todas las plantillas CON su estado (APPROVED, PENDING, REJECTED, …), para la
// pestaña de gestión en Canales. (list, en cambio, solo devuelve las aprobadas
// para poder enviarlas desde el inbox.)
const listAll = async (req, res) => {
  const { accId, agentId } = req.params
  const { channelId } = req.query
  try {
    const channel = await resolveWhatsAppChannel(accId, agentId, channelId)
    const cfg = channel?.config || {}
    if (!cfg.businessAccountId) {
      return res.status(400).json({ error: 'Falta el Business Account ID en la configuración del canal de WhatsApp.' })
    }
    if (!cfg.accessToken) {
      return res.status(400).json({ error: 'Falta el Access Token en la configuración del canal de WhatsApp.' })
    }
    const all = await listWhatsAppTemplates({ businessAccountId: cfg.businessAccountId, accessToken: cfg.accessToken })
    const templates = all.map(t => ({
      name: t.name,
      language: t.language,
      category: t.category,
      status: (t.status || 'UNKNOWN').toUpperCase(),
      components: t.components || [],
    }))
    res.json({ channelId: channel.id, templates })
  } catch (err) {
    console.error('[WA TEMPLATES listAll]', err)
    res.status(502).json({ error: err.message || 'No se pudieron obtener las plantillas' })
  }
}

// POST /api/whatsapp/:accId/:agentId/send-template
// body: { convId, channelId, templateName, language, components, previewText }
const send = async (req, res) => {
  const { accId, agentId } = req.params
  const { convId, channelId, templateName, language = 'es', components = [], previewText } = req.body || {}
  if (!convId || !templateName) return res.status(400).json({ error: 'Faltan convId o templateName' })
  try {
    const channel = await resolveWhatsAppChannel(accId, agentId, channelId)
    const cfg = channel?.config || {}
    if (!cfg.phoneNumberId || !cfg.accessToken) {
      return res.status(400).json({ error: 'El canal de WhatsApp no está configurado (phoneNumberId/accessToken).' })
    }
    // Destinatario: el número del cliente guardado en la conversación
    const [[conv]] = await pool.query('SELECT wa_from FROM conversations WHERE id=? AND account_id=?', [convId, accId])
    const to = conv?.wa_from
    if (!to) return res.status(400).json({ error: 'La conversación no tiene un número de WhatsApp asociado.' })

    const r = await sendWhatsAppTemplate({
      phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken,
      to, templateName, languageCode: language, components: components || [],
    })
    const wamid = r?.messages?.[0]?.id || null
    console.log('[WA TEMPLATES] enviada', templateName, language, 'to', to, '→', JSON.stringify(r?.messages?.[0] || r))

    // Persistimos en la conversación para que el operador vea lo enviado.
    const content = previewText || `[Plantilla] ${templateName}`
    await store.appendMsg(accId, agentId, convId, {
      role: 'assistant', sender: 'human',
      senderName: req.user?.name || 'Asesor',
      content, ts: Date.now(),
      channel: 'whatsapp', channelId: channel.id,
      fromTemplate: true, templateName,
      ...(wamid ? { waMessageId: wamid } : {}),
      status: 'sent',
    })
    res.json({ ok: true, wamid })
  } catch (err) {
    console.error('[WA TEMPLATES send]', err.message)
    res.status(502).json({ error: err.message || 'No se pudo enviar la plantilla' })
  }
}

module.exports = { list, listAll, send }
