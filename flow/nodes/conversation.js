'use strict'
/**
 * Conversation category (backend port) — envío de mensajes y solicitud de input.
 * Nota: los nodos interactivos (botones/lista/confirmación) envían el texto y
 * marcan ctx.awaitInput; en el modelo actual el siguiente mensaje del usuario
 * re-ejecuta el flujo desde el inicio (paridad con el comportamiento del front).
 */

const { interpolate, sendBotMsg, logDebug } = require('../common')

const cmsBaseUrl = () => (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')

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
      const url     = interpolate(node.data?.url || '', ctx.variables)
      const caption = interpolate(node.data?.caption || '', ctx.variables)
      if (!url) throw new Error('URL de imagen vacía')
      await sendBotMsg(ctx, caption, { media: { kind: 'image', url }, mediaUrl: url, kind: 'image' })
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
      const url = interpolate(node.data?.url || '', ctx.variables)
      const fn  = interpolate(node.data?.filename || '', ctx.variables)
      if (!url) throw new Error('URL de documento vacía')
      await sendBotMsg(ctx, fn || '', { media: { kind: 'file', url, filename: fn }, mediaUrl: url, kind: 'file', filename: fn })
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
      await sendBotMsg(ctx, caption, { media: { kind, url, filename: asset.filename }, mediaUrl: url, kind, filename: asset.filename })
      logDebug(ctx, 'flow_run', `📎 Recurso del CMS enviado: ${asset.name}`, { kind })
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
