'use strict'
/**
 * Conversation category (backend port) — envío de mensajes y solicitud de input.
 * Nota: los nodos interactivos (botones/lista/confirmación) envían el texto y
 * marcan ctx.awaitInput; en el modelo actual el siguiente mensaje del usuario
 * re-ejecuta el flujo desde el inicio (paridad con el comportamiento del front).
 */

const { interpolate, sendBotMsg, logDebug } = require('../common')

const cmsBaseUrl = () => (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')

// Resuelve la fuente de un medio: recurso del CMS (assetId) o URL directa.
// Para recursos del CMS devuelve también mediaId/kind/mime/sizeBytes para que la
// UI lo renderice con <MediaMessage> (no solo el texto).
function resolveMedia(node, ctx) {
  if (node.data?.assetId) {
    const a = (ctx.account?.cmsAssets || []).find(x => x.id === node.data.assetId)
    if (!a) throw new Error('Recurso del CMS no encontrado (elígelo de nuevo en el nodo).')
    return { url: `${cmsBaseUrl()}/api/media/${ctx.accId}/${a.mediaId}/raw`, filename: a.filename, mediaId: a.mediaId, kind: a.kind, mime: a.mime, sizeBytes: a.sizeBytes }
  }
  return { url: interpolate(node.data?.url || '', ctx.variables), filename: interpolate(node.data?.filename || '', ctx.variables) }
}
// Construye los metadatos de un mensaje con media (incluye mediaId si viene del CMS).
function mediaMeta(m, fallbackKind, filename) {
  const kind = (m.mediaId && ['image', 'video', 'audio', 'file'].includes(m.kind)) ? m.kind : fallbackKind
  const media = { kind, url: m.url, filename }
  if (m.mediaId) media.mediaId = m.mediaId
  const meta = { media, mediaUrl: m.url, kind, filename }
  if (m.mediaId) Object.assign(meta, { mediaId: m.mediaId, mime: m.mime, sizeBytes: m.sizeBytes })
  return meta
}

const conversationNodes = [
  {
    type: 'send_message', category: 'conversation', label: 'Enviar mensaje',
    async exec(node, ctx) {
      const text = interpolate(node.data?.mensaje || node.data?.text || '', ctx.variables)
      if (!text.trim()) throw new Error('Mensaje vacío')
      const delay = Math.min(Number(node.data?.typing_delay || 0) * 1000, 10000)
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      await sendBotMsg(ctx, text, { format: node.data?.formato || 'markdown' })
    },
  },
  {
    type: 'request_answer', category: 'conversation', label: 'Solicitar respuesta',
    async exec(node, ctx) {
      const q = interpolate(node.data?.pregunta || '', ctx.variables)
      if (q.trim()) await sendBotMsg(ctx, q, { awaitsResponse: true, expectedType: node.data?.tipo_respuesta })
      ctx.awaitInput = {
        type: node.data?.tipo_respuesta || 'texto',
        variableId: node.data?.variable_destino,
        required: node.data?.requerido !== false,
        timeout: node.data?.timeout || '24h',
      }
      logDebug(ctx, 'flow_run', '⏸ Esperando respuesta del usuario', ctx.awaitInput)
    },
  },
  {
    type: 'buttons', category: 'conversation', label: 'Botones',
    async exec(node, ctx) {
      const text = interpolate(node.data?.titulo || '', ctx.variables)
      const raw = node.data?.opciones || ''
      const opts = Array.isArray(raw) ? raw : String(raw).split('\n').map(s => s.trim()).filter(Boolean)
      if (text.trim()) await sendBotMsg(ctx, text, { buttons: opts })
      ctx.awaitInput = { type: 'button', variableId: node.data?.variable_destino, options: opts }
    },
  },
  {
    type: 'list', category: 'conversation', label: 'Lista interactiva',
    async exec(node, ctx) {
      const title = interpolate(node.data?.titulo || '', ctx.variables)
      const body  = interpolate(node.data?.cuerpo || '', ctx.variables)
      let items = []
      try { items = JSON.parse(node.data?.items || '[]') } catch {}
      await sendBotMsg(ctx, body || title, { list: { title, items } })
      ctx.awaitInput = { type: 'list_pick', variableId: node.data?.variable_destino, items }
    },
  },
  {
    type: 'carousel', category: 'conversation', label: 'Carrusel',
    async exec(node, ctx) {
      let cards = []
      try { cards = JSON.parse(node.data?.cards || '[]') } catch {}
      await sendBotMsg(ctx, '', { carousel: cards })
    },
  },
  {
    type: 'send_image', category: 'conversation', label: 'Enviar imagen',
    async exec(node, ctx) {
      const m = resolveMedia(node, ctx)
      const caption = interpolate(node.data?.caption || '', ctx.variables)
      if (!m.url) throw new Error('Falta la imagen (URL, CMS o subida)')
      await sendBotMsg(ctx, caption, mediaMeta(m, 'image', m.filename))
    },
  },
  {
    type: 'send_audio', category: 'conversation', label: 'Enviar audio',
    async exec(node, ctx) {
      const url = interpolate(node.data?.url || '', ctx.variables)
      if (!url) throw new Error('URL de audio vacía')
      await sendBotMsg(ctx, '', { media: { kind: 'audio', url }, mediaUrl: url, kind: 'audio' })
    },
  },
  {
    type: 'send_video', category: 'conversation', label: 'Enviar video',
    async exec(node, ctx) {
      const url     = interpolate(node.data?.url || '', ctx.variables)
      const caption = interpolate(node.data?.caption || '', ctx.variables)
      if (!url) throw new Error('URL de video vacía')
      await sendBotMsg(ctx, caption, { media: { kind: 'video', url }, mediaUrl: url, kind: 'video' })
    },
  },
  {
    type: 'send_document', category: 'conversation', label: 'Enviar documento',
    async exec(node, ctx) {
      const m = resolveMedia(node, ctx)
      if (!m.url) throw new Error('Falta el documento (URL, CMS o subida)')
      const fn = interpolate(node.data?.filename || '', ctx.variables) || m.filename || ''
      await sendBotMsg(ctx, fn || '', mediaMeta(m, 'file', fn))
    },
  },
  {
    type: 'send_cms_resource', category: 'conversation', label: 'Enviar recurso (CMS)',
    async exec(node, ctx) {
      const assets = ctx.account?.cmsAssets || []
      const asset = assets.find(a => a.id === node.data?.assetId)
      if (!asset) throw new Error('Recurso del CMS no encontrado (¿fue eliminado?)')
      const url = `${cmsBaseUrl()}/api/media/${ctx.accId}/${asset.mediaId}/raw`
      const kind = ['image', 'video', 'audio'].includes(asset.kind) ? asset.kind : 'file'
      const caption = interpolate(node.data?.caption || '', ctx.variables)
      await sendBotMsg(ctx, caption, {
        mediaId: asset.mediaId, kind, mime: asset.mime, filename: asset.filename, sizeBytes: asset.sizeBytes,
        media: { kind, url, filename: asset.filename, mediaId: asset.mediaId }, mediaUrl: url,
      })
      logDebug(ctx, 'flow_run', `📎 Recurso del CMS enviado: ${asset.name}`, { kind })
    },
  },
  {
    type: 'send_whatsapp_template', category: 'conversation', label: 'Enviar plantilla WhatsApp',
    async exec(node, ctx) {
      const pool = require('../../db')
      const { parseJ } = require('../../utils')
      const { sendWhatsAppTemplate } = require('../../services/metaSend')
      const store = require('../store')
      const tplName = (node.data?.template || '').trim()
      if (!tplName) throw new Error('Falta el nombre de la plantilla')
      const [[conv]] = await pool.query('SELECT channel_type, channel_id, wa_from FROM conversations WHERE id=? AND account_id=?', [ctx.convId, ctx.accId])
      if (!conv || conv.channel_type !== 'whatsapp' || !conv.wa_from) throw new Error('La conversación no es de WhatsApp')
      const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [ctx.agId, ctx.accId])
      const channels = parseJ(ag?.channels, [])
      const cfg = (channels.find(c => c.id === conv.channel_id) || channels.find(c => c.type === 'whatsapp'))?.config || {}
      if (!cfg.phoneNumberId || !cfg.accessToken) throw new Error('Canal WhatsApp sin configurar')
      const params = String(node.data?.params || '').split('\n').map(p => p.trim()).filter(Boolean)
        .map(tok => ({ type: 'text', text: interpolate(tok, ctx.variables) }))
      const components = params.length ? [{ type: 'body', parameters: params }] : []
      const r = await sendWhatsAppTemplate({
        phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken,
        to: conv.wa_from, templateName: tplName, languageCode: node.data?.language || 'es', components,
      })
      const wamid = r?.messages?.[0]?.id || null
      await store.appendMsg(ctx.accId, ctx.agId, ctx.convId, {
        role: 'assistant', sender: 'ai', content: `📋 Plantilla: ${tplName}`, ts: Date.now(),
        fromFlow: true, fromTemplate: true, templateName: tplName,
        ...(wamid ? { waMessageId: wamid, status: 'sent' } : {}),
      })
      logDebug(ctx, 'flow_run', `📋 Plantilla WhatsApp enviada: ${tplName}`, { to: conv.wa_from })
    },
  },
  {
    type: 'confirmation', category: 'conversation', label: 'Confirmación',
    async exec(node, ctx) {
      const text = interpolate(node.data?.pregunta || '¿Confirmas?', ctx.variables)
      const yes  = node.data?.yes_label || 'Sí'
      const no   = node.data?.no_label  || 'No'
      await sendBotMsg(ctx, text, { buttons: [yes, no] })
      ctx.awaitInput = {
        type: 'confirmation', variableId: node.data?.variable_destino,
        options: [yes, no], yesValue: yes, noValue: no,
      }
    },
  },
]

module.exports = { conversationNodes }
