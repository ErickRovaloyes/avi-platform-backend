'use strict'
/**
 * AI category (backend port) — agente IA con memoria, clasificadores y utilidades.
 * Usa services/aiClient.chat con las keys efectivas de ctx.account.
 */

const { chat, detectProvider, getApiKey } = require('../../services/aiClient')
const { interpolate, sendBotMsg, logDebug, setVarBoth } = require('../common')
const store = require('../store')

const DEFAULT_MODEL = { openai: 'gpt-4o-mini', deepseek: 'deepseek-chat', anthropic: 'claude-sonnet-4-6' }
// Fallback del aviso para clientes recurrentes cuando ni el canal ni la plataforma
// definen uno (mismo texto que el default del super admin en platform.controller).
const DEFAULT_RETURNING_NOTICE = 'Esta persona YA había conversado con el negocio anteriormente; NO la trates como un contacto nuevo ni la saludes como si fuera la primera vez. Retoma el hilo con naturalidad.'

// Tras cada respuesta del asistente, actualiza la memoria persistente del
// cliente (resumen + estado) en segundo plano. Nunca bloquea ni lanza.
function scheduleMemory(ctx) {
  if (ctx?._sandbox || !ctx?.accId || !ctx?.convId) return
  try { require('../../services/conversationMemory').updateMemory(ctx.accId, ctx.agId, ctx.convId).catch(() => {}) } catch {}
}

function buildOneToolDef(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name.replace(/\s+/g, '_').toLowerCase(),
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          (tool.collectFields || []).map(f => [
            f.paramName || f.label.replace(/\s+/g, '_').toLowerCase(),
            { type: 'string', description: f.label },
          ])
        ),
        required: (tool.collectFields || []).filter(f => f.required !== false).map(f => f.paramName || f.label.replace(/\s+/g, '_').toLowerCase()),
      },
    },
  }
}
// La herramienta especial "enviar_recurso" (actionType cms_resource) produce su
// propia definición con el catálogo de recursos. El resto usa la genérica.
function buildToolDefs(toolList, account) {
  const defs = []
  for (const tool of (toolList || [])) {
    if (tool.actionType === 'cms_resource') { const d = buildResourceToolDef(account); if (d) defs.push(d) }
    else if (tool.actionType === 'woocommerce') { if (account?.woocommerce?.connected) defs.push(...buildWooToolDefs()) }
    else if (tool.actionType === 'scheduling') { if (account?.scheduling?.connected) defs.push(...buildAgendaToolDefs(account)) }
    else if (tool.actionType === 'payment') { if (account?.payments?.connected) defs.push(...buildPaymentToolDefs()) }
    else if (tool.actionType === 'meta_catalog') { if (account?.metaCatalog?.connected) defs.push(...buildCatalogToolDefs()) }
    else if (tool.actionType === 'pms') { if (account?.pms?.connected) defs.push(...buildPmsToolDefs(account)) }
    else if (tool.actionType === 'orders') { if (account?.orders?.connected) defs.push(...buildOrdersToolDefs(account)) }
    else { const d = buildOneToolDef(tool); if (d) defs.push(d) }
  }
  return defs
}

async function execToolCall(ctx, toolList, toolName, toolArgs) {
  const normalized = toolName.replace(/\s+/g, '_').toLowerCase()
  // Tienda WooCommerce: la herramienta especial expone varias funciones.
  if (WOO_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'woocommerce')) {
    return wooExec(ctx, normalized, toolArgs)
  }
  // Agenda de citas.
  if (AGENDA_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'scheduling')) {
    return agendaExec(ctx, normalized, toolArgs)
  }
  // Pasarela de pago.
  if (PAYMENT_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'payment')) {
    return paymentExec(ctx, normalized, toolArgs)
  }
  // Catálogo de Meta.
  if (CATALOG_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'meta_catalog')) {
    return catalogExec(ctx, normalized, toolArgs)
  }
  // PMS hotelero (HosRoom/Kunas).
  if (PMS_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'pms')) {
    return pmsExec(ctx, normalized, toolArgs)
  }
  // Pedidos y domicilios.
  if (ORDERS_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'orders')) {
    return ordersExec(ctx, normalized, toolArgs)
  }
  const tool = (toolList || []).find(t => t.name.replace(/\s+/g, '_').toLowerCase() === normalized)
  if (!tool) return `Error: herramienta "${toolName}" no encontrada o no asignada a este prompt.`

  const results = []
  for (const field of (tool.collectFields || [])) {
    const paramName = field.paramName || field.label.replace(/\s+/g, '_').toLowerCase()
    const value = toolArgs?.[paramName]
    if (value !== undefined && field.variableId) {
      await setVarBoth(ctx, field.variableId, value)
      results.push(`${field.label}: "${value}" guardado`)
    }
  }

  if (tool.actionType === 'cms_resource') {
    return sendCmsResource(ctx, toolArgs)
  }
  if (tool.actionType === 'flow' && tool.flowId) {
    const { executeFlow } = require('../engine')
    await executeFlow({ flowId: tool.flowId, accId: ctx.accId, agId: ctx.agId, convId: ctx.convId, triggerContext: { tool: tool.name, args: toolArgs } })
    return results.length ? results.join(', ') : 'Flujo ejecutado'
  }
  return results.length ? results.join(', ') : 'Ejecutado'
}

// ── Recursos del CMS: herramienta especial "enviar_recurso" ────────────────────
// Es una Herramienta IA Especial: se ASIGNA al prompt en la lista de herramientas
// (no está anclada al nodo). Cuando el prompt la tiene asignada, el modelo puede
// enviar imágenes/documentos del CMS. Soporta carpetas "super unidad" (un producto
// con varias fotos): sin detalle envía todas; con detalle busca la foto concreta.
function resourceBaseUrl() {
  return (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
}
const normResourceName = s => String(s || '').trim().toLowerCase()
function tokenize(s) {
  return normResourceName(s).split(/[^a-z0-9áéíóúñü]+/i).filter(w => w.length > 1)
}
// Puntúa cuántos tokens de la consulta aparecen en el texto (palabras largas pesan más).
function scoreText(queryTokens, text) {
  const t = normResourceName(text)
  let score = 0
  for (const qt of queryTokens) { if (qt && t.includes(qt)) score += qt.length >= 4 ? 2 : 1 }
  return score
}
function assetHaystack(a) { return `${a.name} ${a.description || ''} ${(a.tags || []).join(' ')} ${a.category || ''}` }
function pickBest(list, queryTokens) {
  let best = { asset: null, score: -1 }
  for (const a of list) { const sc = scoreText(queryTokens, assetHaystack(a)); if (sc > best.score) best = { asset: a, score: sc } }
  return best
}
function buildResourceToolDef(account) {
  const assets = account?.cmsAssets || []
  const folders = account?.cmsFolders || []
  if (!assets.length) return null
  const unitFolders = folders.filter(f => f.type === 'unit' && assets.some(a => a.folderId === f.id))
  const lines = []
  if (unitFolders.length) {
    lines.push('PRODUCTOS / SERVICIOS (cada uno agrupa varias fotos — al pedirlo se envían todas, o una concreta si el usuario especifica):')
    unitFolders.forEach(f => lines.push(`• ${f.name}${f.description ? ` — ${f.description}` : ''}`))
  }
  const loose = assets.filter(a => { const fol = folders.find(x => x.id === a.folderId); return !fol || fol.type !== 'unit' })
  if (loose.length) {
    lines.push('RECURSOS SUELTOS:')
    loose.slice(0, 60).forEach(a => lines.push(`• ${a.name}${a.description ? `: ${a.description}` : ''}${(a.tags || []).length ? ` [${a.tags.join(', ')}]` : ''}${a.category ? ` (${a.category})` : ''}`))
  }
  return {
    type: 'function',
    function: {
      name: 'enviar_recurso',
      description: `Envía al usuario imágenes o documentos del CMS. Úsalo cuando el usuario los pida o cuando ayuden (catálogo, lista de precios, foto de un producto/servicio, folleto, manual…). En "recurso" indica el producto/servicio o recurso de esta lista. Si es un PRODUCTO/SERVICIO y el usuario solo quiere verlo, deja "detalle" vacío y se enviarán todas sus fotos; si pide algo concreto (p. ej. "el baño", "vista de noche"), ponlo en "detalle" y se enviará la foto que mejor coincida.\n${lines.join('\n')}`,
      parameters: {
        type: 'object',
        properties: {
          recurso: { type: 'string', description: 'Producto/servicio o recurso a enviar (lo más parecido de la lista).' },
          detalle: { type: 'string', description: 'Opcional: aspecto/foto concreta que pide el usuario dentro de ese producto.' },
          mensaje: { type: 'string', description: 'Texto opcional para acompañar el/los archivo(s).' },
        },
        required: ['recurso'],
      },
    },
  }
}
async function sendOneAsset(ctx, a, caption) {
  const url = `${resourceBaseUrl()}/api/media/${ctx.accId}/${a.mediaId}/raw`
  const kind = ['image', 'video', 'audio'].includes(a.kind) ? a.kind : 'file'
  // mediaId (+kind/mime/filename/sizeBytes) → la UI lo renderiza con <MediaMessage>;
  // media/mediaUrl → entrega al canal externo (WhatsApp/Messenger/IG).
  await sendBotMsg(ctx, caption || '', {
    mediaId: a.mediaId, kind, mime: a.mime, filename: a.filename, sizeBytes: a.sizeBytes,
    media: { kind, url, filename: a.filename, mediaId: a.mediaId }, mediaUrl: url,
  })
}
async function sendCmsResource(ctx, args) {
  const assets = ctx.account?.cmsAssets || []
  const folders = ctx.account?.cmsFolders || []
  if (!assets.length) return 'No hay recursos en la biblioteca del CMS.'
  const recurso = args?.recurso || ''
  const detalle = args?.detalle || ''
  const caption = args?.mensaje || ''
  const recTokens = tokenize(recurso)

  // 1) ¿"recurso" coincide con una carpeta (producto/servicio)?
  const folderScored = folders
    .map(f => ({ f, score: scoreText(recTokens, f.name) + scoreText(recTokens, f.description || ''), items: assets.filter(a => a.folderId === f.id) }))
    .filter(x => x.items.length)
    .sort((a, b) => b.score - a.score)
  const topFolder = folderScored[0]
  if (topFolder && topFolder.score >= 2) {
    const { f, items } = topFolder
    if (f.type === 'unit' && !detalle.trim()) {
      // Super unidad sin detalle → enviar todas las fotos del producto/servicio.
      for (let i = 0; i < items.length; i++) await sendOneAsset(ctx, items[i], i === 0 ? caption : '')
      logDebug(ctx, 'tool_result', `📎 Enviadas ${items.length} fotos de "${f.name}"`, {})
      return `Te envié ${items.length} archivo(s) de "${f.name}".`
    }
    // Buscar dentro de la carpeta la foto concreta.
    const q2 = tokenize(`${detalle} ${detalle ? '' : recurso}`)
    const best = pickBest(items, q2.length ? q2 : recTokens)
    if (best.asset && best.score >= 1) { await sendOneAsset(ctx, best.asset, caption); return `Envié "${best.asset.name}" de "${f.name}".` }
    const approx = best.asset || items[0]
    await sendOneAsset(ctx, approx, '')
    return `No tengo exactamente lo que buscas dentro de "${f.name}". Te envío lo más aproximado: "${approx.name}".`
  }

  // 2) Buscar entre todos los recursos (nombre, descripción, etiquetas, categoría).
  const queryTokens = [...recTokens, ...tokenize(detalle)]
  const best = pickBest(assets, queryTokens)
  if (best.asset && best.score >= 2) {
    await sendOneAsset(ctx, best.asset, caption)
    logDebug(ctx, 'tool_result', `📎 Recurso enviado: ${best.asset.name}`, { score: best.score })
    return `Recurso "${best.asset.name}" enviado al usuario.`
  }
  // 3) Sin coincidencia clara → enviar lo más aproximado + aviso (condición pedida).
  if (best.asset) {
    await sendOneAsset(ctx, best.asset, '')
    return `No encontré exactamente lo que buscas (o no lo entendí del todo). Te muestro lo más aproximado: "${best.asset.name}". Si no es lo que querías, descríbemelo de otra forma.`
  }
  return `No encontré ningún recurso parecido a "${recurso}".`
}

// ── Tienda WooCommerce: herramienta especial con varias funciones ──────────────
const WOO_FUNCS = new Set(['buscar_productos', 'enviar_producto', 'crear_pedido'])
function buildWooToolDefs() {
  return [
    { type: 'function', function: { name: 'buscar_productos',
      description: 'Busca productos en la tienda para responder preguntas sobre disponibilidad, precios o características. Devuelve nombre, precio y descripción de los productos que coincidan.',
      parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'Nombre, categoría o palabras clave del producto que busca el usuario' } }, required: ['consulta'] } } },
    { type: 'function', function: { name: 'enviar_producto',
      description: 'Envía al usuario un producto con sus FOTOS y una ficha (nombre, precio, link). Úsalo cuando el usuario quiera VER un producto o pida su foto/presentación/catálogo.',
      parameters: { type: 'object', properties: { producto: { type: 'string', description: 'Nombre o palabras clave del producto a enviar' } }, required: ['producto'] } } },
    { type: 'function', function: { name: 'crear_pedido',
      description: 'Crea un pedido en la tienda y envía al usuario el LINK DE PAGO. Úsalo SOLO cuando el usuario confirme que quiere comprar. Tras el pago, se confirma automáticamente.',
      parameters: { type: 'object', properties: { producto: { type: 'string', description: 'Producto que quiere comprar' }, cantidad: { type: 'string', description: 'Cantidad (por defecto 1)' } }, required: ['producto'] } } },
  ]
}
async function wooExec(ctx, fnName, args) {
  const store = require('../../services/store')
  const accId = ctx.accId
  const cfg = await store.loadConfig(accId)
  const maxImgs = store.maxImages(cfg)
  try {
    if (fnName === 'buscar_productos') {
      const list = await store.searchProducts(accId, args?.consulta || args?.query || '')
      if (!list.length) return 'No encontré productos para esa búsqueda en la tienda.'
      logDebug(ctx, 'tool_result', `🛒 ${list.length} producto(s) encontrados`, {})
      return 'Productos encontrados:\n' + list.slice(0, 8).map((p, i) => {
        const d = (p.shortDescription || p.description || '').slice(0, 200)
        return `${i + 1}. ${p.name} — ${p.price} ${p.currency}${p.stockStatus === 'outofstock' ? ' (agotado)' : ''}${d ? `\n   ${d}` : ''}`
      }).join('\n')
    }
    if (fnName === 'enviar_producto') {
      const list = await store.searchProducts(accId, args?.producto || args?.consulta || '')
      const p = list[0]
      if (!p) return 'No encontré ese producto para enviarlo.'
      const desc = p.shortDescription || p.description || ''
      const caption = `*${p.name}* — ${p.price} ${p.currency}${desc ? `\n${desc}` : ''}${p.permalink ? `\n${p.permalink}` : ''}`
      const imgs = (p.images || []).slice(0, maxImgs)
      if (!imgs.length) { await sendBotMsg(ctx, caption) }
      else { for (let i = 0; i < imgs.length; i++) await sendBotMsg(ctx, i === 0 ? caption : '', { media: { kind: 'image', url: imgs[i] }, mediaUrl: imgs[i] }) }
      logDebug(ctx, 'tool_result', `🛒 Enviado "${p.name}" (${imgs.length} foto/s)`, {})
      return `Envié el producto "${p.name}" con ${imgs.length} foto(s) al usuario.`
    }
    if (fnName === 'crear_pedido') {
      const list = await store.searchProducts(accId, args?.producto || '')
      const p = list[0]
      if (!p) return 'No encontré ese producto para crear el pedido.'
      const qty = Math.max(1, parseInt(args?.cantidad) || 1)
      const customer = { name: ctx.variables?.var_nombre || ctx.variables?.nombre || '', phone: ctx.variables?.telefono || '', email: ctx.variables?.email || '' }
      const order = await store.createOrder(accId, { items: [{ productId: p.id, variantId: p.variantId, quantity: qty }], customer, convId: ctx.convId, agId: ctx.agId })
      await sendBotMsg(ctx, `🛒 Pedido creado: ${qty} × ${p.name}\nTotal: ${order.total} ${order.currency}\n\n💳 Paga aquí:\n${order.payUrl}\n\nApenas completes el pago te confirmo automáticamente.`)
      logDebug(ctx, 'tool_result', `🛒 Pedido #${order.orderId} creado (${order.total} ${order.currency})`, {})
      return `Pedido #${order.orderId} creado por ${order.total} ${order.currency}. Ya envié el link de pago al usuario.`
    }
  } catch (e) {
    logDebug(ctx, 'error', `Tienda: ${e.message}`, {})
    return `No se pudo completar la acción de la tienda: ${e.message}`
  }
  return 'Acción de tienda no reconocida.'
}

// ── Catálogo de Meta: herramienta especial (responder / enviar / pedidos) ──────
const CATALOG_FUNCS = new Set(['buscar_en_catalogo', 'enviar_producto_catalogo', 'enviar_catalogo', 'crear_pedido_catalogo'])
function buildCatalogToolDefs() {
  return [
    { type: 'function', function: { name: 'buscar_en_catalogo',
      description: 'Busca productos en el catálogo conectado para responder preguntas sobre disponibilidad, precios o características. Devuelve nombre, precio y descripción de los que coincidan.',
      parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'Nombre, categoría o palabras clave del producto' } }, required: ['consulta'] } } },
    { type: 'function', function: { name: 'enviar_producto_catalogo',
      description: 'Envía al usuario un producto del catálogo con su FOTO y ficha (nombre, precio, link). Úsalo cuando el usuario quiera VER un producto o pida su foto.',
      parameters: { type: 'object', properties: { producto: { type: 'string', description: 'Nombre o palabras clave del producto a enviar' } }, required: ['producto'] } } },
    { type: 'function', function: { name: 'enviar_catalogo',
      description: 'Envía al usuario el catálogo completo (lista de productos con precios). Úsalo cuando el usuario pida ver todo el catálogo o "qué productos tienen".',
      parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'crear_pedido_catalogo',
      description: 'Genera un pedido a partir de un producto del catálogo. Si hay pasarela de pago conectada, envía el link de pago; si no, registra el pedido para que un asesor lo confirme. Úsalo SOLO cuando el usuario confirme que quiere comprar.',
      parameters: { type: 'object', properties: { producto: { type: 'string', description: 'Producto que quiere comprar' }, cantidad: { type: 'string', description: 'Cantidad (por defecto 1)' } }, required: ['producto'] } } },
  ]
}
async function catalogExec(ctx, fnName, args) {
  const catalog = require('../../services/metaCatalog')
  const accId = ctx.accId
  try {
    if (fnName === 'buscar_en_catalogo') {
      const list = await catalog.searchProducts(accId, args?.consulta || args?.query || '')
      if (!list.length) return 'No encontré productos para esa búsqueda en el catálogo.'
      logDebug(ctx, 'tool_result', `🛍 ${list.length} producto(s) en catálogo`, {})
      return 'Productos encontrados:\n' + list.slice(0, 8).map((p, i) => {
        const d = (p.description || '').slice(0, 160)
        const out = p.availability && !/in stock|available/i.test(p.availability) ? ' (no disponible)' : ''
        return `${i + 1}. ${p.name} — ${p.price || ''}${out}${d ? `\n   ${d}` : ''}`
      }).join('\n')
    }
    if (fnName === 'enviar_producto_catalogo') {
      const list = await catalog.searchProducts(accId, args?.producto || args?.consulta || '')
      const p = list[0]
      if (!p) return 'No encontré ese producto en el catálogo para enviarlo.'
      const desc = (p.description || '').slice(0, 300)
      const caption = `*${p.name}* — ${p.price || ''}${desc ? `\n${desc}` : ''}${p.url ? `\n${p.url}` : ''}`
      if (p.image_url) await sendBotMsg(ctx, caption, { media: { kind: 'image', url: p.image_url }, mediaUrl: p.image_url })
      else await sendBotMsg(ctx, caption)
      logDebug(ctx, 'tool_result', `🛍 Enviado "${p.name}"`, {})
      return `Envié el producto "${p.name}" al usuario.`
    }
    if (fnName === 'enviar_catalogo') {
      const list = await catalog.getProducts(accId, { limit: 100 })
      if (!list.length) return 'El catálogo no tiene productos.'
      const shown = list.slice(0, 40)
      const lines = shown.map(p => `• ${p.name} — ${p.price || ''}`).join('\n')
      await sendBotMsg(ctx, `🛍 *Catálogo* (${list.length} producto/s):\n${lines}${list.length > shown.length ? '\n… y más. Pídeme uno para verlo en detalle.' : ''}`)
      logDebug(ctx, 'tool_result', `🛍 Catálogo enviado (${shown.length}/${list.length})`, {})
      return `Envié el catálogo (${shown.length} de ${list.length} productos) al usuario.`
    }
    if (fnName === 'crear_pedido_catalogo') {
      const list = await catalog.searchProducts(accId, args?.producto || '')
      const p = list[0]
      if (!p) return 'No encontré ese producto en el catálogo para crear el pedido.'
      const qty = Math.max(1, parseInt(args?.cantidad) || 1)
      const unit = parseFloat(String(p.price || '').replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0
      const total = unit * qty
      if (ctx.account?.payments?.connected && total > 0) {
        const payments = require('../../services/payments')
        const r = await payments.createPaymentLink(accId, { amount: total, description: `${qty} × ${p.name}`, convId: ctx.convId, agId: ctx.agId })
        await sendBotMsg(ctx, `🛒 Pedido: ${qty} × ${p.name}\nTotal: ${r.amount} ${r.currency}\n\n💳 Paga aquí:\n${r.url}\n\nApenas completes el pago te confirmo automáticamente.`)
        logDebug(ctx, 'tool_result', `🛒 Pedido catálogo ${r.amount} ${r.currency}`, {})
        return `Pedido creado por ${r.amount} ${r.currency} y envié el link de pago al usuario.`
      }
      await sendBotMsg(ctx, `🛒 Pedido registrado:\n${qty} × ${p.name}${total ? `\nTotal estimado: ${total} ${p.currency || ''}` : ''}\n\nUn asesor confirmará tu pedido en breve.`)
      logDebug(ctx, 'tool_result', `🛒 Pedido catálogo registrado (${qty} × ${p.name})`, {})
      return `Pedido de ${qty} × ${p.name} registrado (sin pasarela de pago conectada; lo confirmará un asesor).`
    }
  } catch (e) {
    logDebug(ctx, 'error', `Catálogo: ${e.message}`, {})
    return `No se pudo completar la acción del catálogo: ${e.message}`
  }
  return 'Acción de catálogo no reconocida.'
}

// ── Agenda de citas: herramienta especial con varias funciones ─────────────────
const AGENDA_FUNCS = new Set(['ver_disponibilidad', 'recomendar_citas', 'agendar_cita', 'mover_cita', 'cancelar_cita', 'ver_mis_citas'])
function buildAgendaToolDefs(account) {
  const cals = account?.scheduling?.calendars || []
  if (!cals.length) return []
  const menu = cals.map(c => `• ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n')
  const multi = cals.length > 1
  const servicioDesc = multi
    ? `Calendario/servicio a usar. ELIGE según la DESCRIPCIÓN del que mejor encaje con lo que pide el cliente (pasa el nombre del calendario). Calendarios disponibles:\n${menu}`
    : `(opcional; solo hay un calendario: ${cals[0].name})`
  return [
    { type: 'function', function: { name: 'ver_disponibilidad', description: 'Muestra los horarios LIBRES de un calendario para una fecha. Úsalo cuando el cliente pregunte por disponibilidad de un día concreto. No inventes horarios.', parameters: { type: 'object', properties: { fecha: { type: 'string', description: 'Fecha YYYY-MM-DD (o "hoy"/"mañana")' }, servicio: { type: 'string', description: servicioDesc } }, required: ['fecha'] } } },
    { type: 'function', function: { name: 'recomendar_citas', description: 'Recomienda las PRÓXIMAS citas disponibles (siguientes días con cupo). Úsalo cuando el cliente quiere agendar pero no fijó un día.', parameters: { type: 'object', properties: { servicio: { type: 'string', description: servicioDesc } } } } },
    { type: 'function', function: { name: 'agendar_cita', description: 'Agenda una cita. Úsalo SOLO cuando el cliente confirme fecha y hora (de las que diste por disponibilidad) y tengas su nombre.', parameters: { type: 'object', properties: { fecha: { type: 'string', description: 'YYYY-MM-DD' }, hora: { type: 'string', description: 'HH:MM' }, servicio: { type: 'string', description: servicioDesc }, nombre: { type: 'string', description: 'Nombre del cliente' }, telefono: { type: 'string' }, email: { type: 'string' }, nota: { type: 'string' } }, required: ['fecha', 'hora'] } } },
    { type: 'function', function: { name: 'mover_cita', description: 'Reagenda la cita del cliente a otra fecha/hora.', parameters: { type: 'object', properties: { nueva_fecha: { type: 'string', description: 'YYYY-MM-DD' }, nueva_hora: { type: 'string', description: 'HH:MM' }, telefono: { type: 'string' }, bookingId: { type: 'string', description: 'id de la cita si el cliente tiene varias' } }, required: ['nueva_fecha', 'nueva_hora'] } } },
    { type: 'function', function: { name: 'cancelar_cita', description: 'Cancela la cita del cliente.', parameters: { type: 'object', properties: { telefono: { type: 'string' }, bookingId: { type: 'string', description: 'id de la cita si tiene varias' } } } } },
    { type: 'function', function: { name: 'ver_mis_citas', description: 'Muestra las citas del cliente: las ACTIVAS/próximas y las ANTERIORES (historial). Úsalo cuando el cliente pregunte "¿qué citas tengo?" o por su historial.', parameters: { type: 'object', properties: { telefono: { type: 'string', description: 'Teléfono del cliente (si no, se toma el de la conversación)' } } } } },
  ]
}
async function agendaExec(ctx, fnName, args) {
  try {
    const sched = require('../../services/scheduling')
    const r = await sched.toolCall(ctx.accId, fnName, args || {}, { convId: ctx.convId, agId: ctx.agId })
    logDebug(ctx, 'tool_result', `📅 ${fnName}`, {})
    return r?.text || 'Hecho.'
  } catch (e) { logDebug(ctx, 'error', `Agenda: ${e.message}`, {}); return `No se pudo completar la acción de agenda: ${e.message}` }
}

// ── Pasarela de pago: herramienta especial con varias funciones ────────────────
const PAYMENT_FUNCS = new Set(['generar_link_pago', 'verificar_pago'])
function buildPaymentToolDefs() {
  return [
    { type: 'function', function: { name: 'generar_link_pago',
      description: 'Genera un LINK DE PAGO y se lo envía al usuario. Úsalo cuando el usuario quiera pagar y tengas claro el monto. Cuando complete el pago se detecta automáticamente.',
      parameters: { type: 'object', properties: {
        monto: { type: 'string', description: 'Monto a cobrar en la unidad mayor de la moneda (p. ej. 50000 para 50.000 COP)' },
        concepto: { type: 'string', description: 'Concepto/descripción breve del pago (qué se está cobrando)' },
      }, required: ['monto'] } } },
    { type: 'function', function: { name: 'verificar_pago',
      description: 'Verifica si el último pago de esta conversación ya se realizó. Úsalo cuando el usuario diga que ya pagó o preguntes por el estado.',
      parameters: { type: 'object', properties: {} } } },
  ]
}
async function paymentExec(ctx, fnName, args) {
  const payments = require('../../services/payments')
  const accId = ctx.accId
  try {
    if (fnName === 'generar_link_pago') {
      const amount = parseFloat(String(args?.monto || '').replace(/[^\d.]/g, ''))
      if (!amount || amount <= 0) return 'Indica un monto válido para generar el link de pago.'
      const r = await payments.createPaymentLink(accId, {
        amount, description: args?.concepto || 'Pago', convId: ctx.convId, agId: ctx.agId,
      })
      await sendBotMsg(ctx, `💳 Aquí está tu link de pago por ${r.amount} ${r.currency}:\n${r.url}\n\nApenas completes el pago te confirmo automáticamente.`)
      logDebug(ctx, 'tool_result', `💳 Link de pago ${r.amount} ${r.currency}`, {})
      return `Link de pago generado por ${r.amount} ${r.currency} y enviado al usuario.`
    }
    if (fnName === 'verificar_pago') {
      const st = await payments.latestIntentStatus(accId, ctx.convId)
      if (!st) return 'No hay ningún pago pendiente en esta conversación.'
      logDebug(ctx, 'tool_result', `💳 Estado pago: ${st.status}`, {})
      if (st.status === 'approved') return `El pago de ${st.amount} ${st.currency} está CONFIRMADO.`
      if (st.status === 'declined') return `El pago de ${st.amount} ${st.currency} fue RECHAZADO o no se completó.`
      return `El pago de ${st.amount} ${st.currency} aún está PENDIENTE (sin confirmar todavía).`
    }
  } catch (e) {
    logDebug(ctx, 'error', `Pasarela: ${e.message}`, {})
    return `No se pudo completar la acción de pago: ${e.message}`
  }
  return 'Acción de pago no reconocida.'
}

// ── PMS hotelero (HosRoom/Kunas): herramienta especial con varias funciones ────
// Lógica en services/pms.js (server-side). El servicio devuelve { text, media? };
// aquí se envían las fotos al chat y se dispara el flujo post-reserva si existe.
const PMS_FUNCS = new Set(['ver_propiedades', 'ver_habitaciones', 'ver_disponibilidad_hotel', 'reservar_habitacion', 'reagendar_reserva', 'cancelar_reserva', 'ver_reserva'])
function buildPmsToolDefs(account) {
  const hotel = account?.pms?.hotelName ? ` del hotel "${account.pms.hotelName}"` : ''
  const multi = !!account?.pms?.multiProperty
  const propNames = (account?.pms?.properties || []).map(p => p.name).join(', ')
  const propParam = multi ? { propiedad: { type: 'string', description: `Propiedad/hotel en el que operar (OBLIGATORIO, hay varias: ${propNames}). Usa ver_propiedades y pregunta al cliente si no la sabes.` } } : {}
  const defs = []
  if (multi) defs.push(
    { type: 'function', function: { name: 'ver_propiedades',
      description: `Lista las propiedades/hoteles disponibles (${propNames}). Úsalo cuando el cliente pregunte qué propiedades/hoteles hay o antes de mostrar habitaciones/disponibilidad, para saber en cuál operar.`,
      parameters: { type: 'object', properties: {} } } },
  )
  defs.push(
    { type: 'function', function: { name: 'ver_habitaciones',
      description: `Muestra las habitaciones${hotel} con sus FOTOS reales, capacidad y planes. Úsalo cuando el cliente pregunte por las habitaciones o pida fotos. Cada vez que lo llames envía fotos NUEVAS (distintas a las ya enviadas); si el cliente pide "más fotos", vuelve a llamarlo. Cuando ya no queden más, la herramienta lo indica y puedes reenviarlas desde el principio con desde_inicio=true.`,
      parameters: { type: 'object', properties: {
        habitacion: { type: 'string', description: 'Nombre de una habitación concreta para enviar sus fotos y ficha (vacío = panorama de la propiedad)' },
        desde_inicio: { type: 'boolean', description: 'true para reenviar las fotos desde el principio (cuando el cliente ya vio todas y quiere verlas otra vez)' },
        ...propParam,
      } } } },
    { type: 'function', function: { name: 'ver_disponibilidad_hotel',
      description: 'Consulta la disponibilidad REAL del hotel para un rango de fechas con precios y cotización total. Úsalo antes de reservar. NUNCA inventes precios ni disponibilidad.',
      parameters: { type: 'object', properties: {
        checkin: { type: 'string', description: 'Fecha de entrada YYYY-MM-DD' },
        checkout: { type: 'string', description: 'Fecha de salida YYYY-MM-DD' },
        adultos: { type: 'number', description: 'Número de adultos (mínimo 1)' },
        ninos: { type: 'number', description: 'Número de niños (opcional)' },
        infantes: { type: 'number', description: 'Número de infantes (opcional)' },
        habitaciones: { type: 'number', description: 'Número de habitaciones (opcional)' },
        codigo_promocional: { type: 'string', description: 'Código promocional si el cliente tiene uno (opcional)' },
        ...propParam,
      }, required: ['checkin', 'checkout', 'adultos'] } } },
    { type: 'function', function: { name: 'reservar_habitacion',
      description: 'Crea la RESERVA en el PMS del hotel. Úsalo SOLO cuando el cliente confirme fechas y opción, y tengas su nombre, email y teléfono. Devuelve el código de reserva y el link de pago.',
      parameters: { type: 'object', properties: {
        checkin: { type: 'string', description: 'YYYY-MM-DD' },
        checkout: { type: 'string', description: 'YYYY-MM-DD' },
        adultos: { type: 'number' },
        ninos: { type: 'number' },
        opcion: { type: 'number', description: 'Número de opción de la última consulta de disponibilidad' },
        plan: { type: 'string', description: 'Nombre de la habitación/plan elegido (si no usas "opcion")' },
        nombre: { type: 'string', description: 'Nombre completo del huésped' },
        email: { type: 'string', description: 'Email del huésped (obligatorio para la reserva)' },
        telefono: { type: 'string', description: 'Teléfono del huésped (si no, se toma el de la conversación)' },
        nota: { type: 'string', description: 'Petición especial del huésped (opcional)' },
        codigo_promocional: { type: 'string' },
        ...propParam,
      }, required: ['checkin', 'checkout', 'adultos'] } } },
    { type: 'function', function: { name: 'ver_reserva',
      description: 'Consulta el estado y detalle de una reserva por su código (ej. HR-123456789). Úsalo para seguimiento cuando el cliente pregunte por su reserva.',
      parameters: { type: 'object', properties: {
        codigo: { type: 'string', description: 'Código de la reserva' },
      }, required: ['codigo'] } } },
    { type: 'function', function: { name: 'reagendar_reserva',
      description: 'Registra la solicitud de CAMBIO DE FECHAS de una reserva existente (el equipo del hotel la procesa y confirma). Pide el código y las nuevas fechas.',
      parameters: { type: 'object', properties: {
        codigo: { type: 'string', description: 'Código de la reserva (HR-…)' },
        nueva_checkin: { type: 'string', description: 'Nueva fecha de entrada YYYY-MM-DD' },
        nueva_checkout: { type: 'string', description: 'Nueva fecha de salida YYYY-MM-DD' },
        motivo: { type: 'string' },
      }, required: ['codigo', 'nueva_checkin', 'nueva_checkout'] } } },
    { type: 'function', function: { name: 'cancelar_reserva',
      description: 'Registra la solicitud de CANCELACIÓN de una reserva (el equipo del hotel la procesa y confirma). Pide el código de la reserva.',
      parameters: { type: 'object', properties: {
        codigo: { type: 'string', description: 'Código de la reserva (HR-…)' },
        motivo: { type: 'string' },
      }, required: ['codigo'] } } },
  )
  return defs
}
async function pmsExec(ctx, fnName, args) {
  try {
    const pms = require('../../services/pms')
    const r = await pms.toolCall(ctx.accId, fnName, args || {}, { convId: ctx.convId, agId: ctx.agId })
    // Envía las fotos al chat (web + canal externo).
    for (const m of (r.media || [])) {
      await sendBotMsg(ctx, m.caption || '', { kind: 'image', media: { kind: 'image', url: m.url }, mediaUrl: m.url })
    }
    logDebug(ctx, 'tool_result', `🏨 PMS ${fnName}${r.bookingCode ? ` → ${r.bookingCode}` : ''}`, { media: (r.media || []).length })
    // Flujo post-reserva (opcional, configurado en Zona IA → PMS).
    if (r.booked) {
      try {
        const cfg = await pms.loadConfig(ctx.accId)
        if (cfg?.postBookingFlowId) {
          const { executeFlow } = require('../engine')
          executeFlow({ flowId: cfg.postBookingFlowId, accId: ctx.accId, agId: ctx.agId, convId: ctx.convId, triggerContext: { pmsBookingCode: r.bookingCode } }).catch(() => {})
        }
      } catch {}
    }
    return r?.text || 'Hecho.'
  } catch (e) {
    logDebug(ctx, 'error', `PMS: ${e.message}`, {})
    return `No se pudo completar la acción del PMS: ${e.message}`
  }
}

// ── Pedidos y domicilios ───────────────────────────────────────────────────────
const ORDERS_FUNCS = new Set(['ver_menu', 'agregar_al_pedido', 'ver_carrito', 'ver_pedido', 'quitar_del_pedido', 'fijar_datos_entrega', 'aplicar_cupon', 'confirmar_pedido', 'estado_pedido'])
function buildOrdersToolDefs(account) {
  const o = account?.orders || {}
  const biz = o.businessName ? ` de "${o.businessName}"` : ''
  const typeLabel = { delivery: 'domicilio', pickup: 'para recoger', dinein: 'en el local', scheduled: 'programado' }
  const types = (Array.isArray(o.orderTypes) && o.orderTypes.length ? o.orderTypes : ['delivery', 'pickup']).map(t => typeLabel[t] || t).join(', ')
  const methods = (Array.isArray(o.paymentMethods) && o.paymentMethods.length ? o.paymentMethods : ['online', 'cash']).map(m => m === 'online' ? 'pago en línea' : 'contra entrega').join(' y ')
  return [
    { type: 'function', function: { name: 'ver_menu',
      description: `Muestra el menú/catálogo${biz} con precios (y fotos si el cliente pide una categoría). Úsalo cuando pregunten qué hay, el menú, la carta o los precios. NUNCA inventes productos ni precios.`,
      parameters: { type: 'object', properties: {
        categoria: { type: 'string', description: 'Categoría concreta para filtrar y enviar fotos (vacío = panorama de todo el menú)' },
      } } } },
    { type: 'function', function: { name: 'agregar_al_pedido',
      description: 'Agrega un producto al pedido (carrito) del cliente. Úsalo cada vez que el cliente pida algo. Puedes incluir adiciones/modificadores y una nota.',
      parameters: { type: 'object', properties: {
        producto: { type: 'string', description: 'Nombre del producto tal como aparece en el menú' },
        cantidad: { type: 'number', description: 'Cantidad (mínimo 1)' },
        adiciones: { type: 'string', description: 'Adiciones/modificadores separados por coma (ej. "extra queso, sin cebolla")' },
        nota: { type: 'string', description: 'Nota para la cocina sobre este producto (opcional)' },
      }, required: ['producto'] } } },
    { type: 'function', function: { name: 'ver_carrito',
      description: 'Muestra el resumen del pedido actual con los productos y el total. Úsalo cuando el cliente quiera revisar su pedido antes de confirmar.',
      parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'quitar_del_pedido',
      description: 'Quita un producto del pedido. Indica el número de línea (de ver_carrito) o el nombre del producto.',
      parameters: { type: 'object', properties: {
        indice: { type: 'number', description: 'Número de la línea a quitar (según ver_carrito)' },
        producto: { type: 'string', description: 'Nombre del producto a quitar (si no usas el número)' },
      } } } },
    { type: 'function', function: { name: 'fijar_datos_entrega',
      description: `Fija el tipo de entrega (disponibles: ${types}) y los datos. Para domicilio pide dirección y zona (calcula el envío). Úsalo antes de confirmar.`,
      parameters: { type: 'object', properties: {
        tipo: { type: 'string', description: 'domicilio | recoger | local | programado' },
        direccion: { type: 'string', description: 'Dirección de entrega (para domicilio)' },
        referencias: { type: 'string', description: 'Referencias o indicaciones para llegar (opcional)' },
        zona: { type: 'string', description: 'Zona/barrio de entrega para calcular el costo de envío' },
        mesa: { type: 'string', description: 'Número/identificador de mesa (para consumo en el local)' },
        para: { type: 'string', description: 'Fecha/hora para pedido programado' },
      } } } },
    { type: 'function', function: { name: 'aplicar_cupon',
      description: 'Aplica un cupón de descuento al pedido actual. Úsalo cuando el cliente dé un código de cupón. Valida el cupón y descuenta del subtotal.',
      parameters: { type: 'object', properties: {
        codigo: { type: 'string', description: 'Código del cupón que dio el cliente' },
      }, required: ['codigo'] } } },
    { type: 'function', function: { name: 'confirmar_pedido',
      description: `Cierra y CONFIRMA el pedido. Úsalo SOLO cuando el pedido tenga productos y, si es domicilio, dirección y zona. Métodos de pago: ${methods}. Devuelve el código del pedido y, si es en línea, el link de pago.`,
      parameters: { type: 'object', properties: {
        nombre: { type: 'string', description: 'Nombre del cliente (si no, se toma el de la conversación)' },
        telefono: { type: 'string', description: 'Teléfono del cliente (si no, se toma el de la conversación)' },
        metodo_pago: { type: 'string', description: 'en línea | contra entrega (efectivo)' },
        paga_con: { type: 'string', description: 'Con cuánto paga en efectivo, para calcular el vuelto (solo contra entrega)' },
        propina: { type: 'number', description: 'Propina en dinero (opcional)' },
        cupon: { type: 'string', description: 'Código de cupón a aplicar (opcional si ya se aplicó con aplicar_cupon)' },
        nota: { type: 'string', description: 'Nota general del pedido (opcional)' },
      } } } },
    { type: 'function', function: { name: 'estado_pedido',
      description: 'Consulta el estado de un pedido por su código (ej. P-AB12C). Úsalo para seguimiento cuando el cliente pregunte por su pedido.',
      parameters: { type: 'object', properties: {
        codigo: { type: 'string', description: 'Código del pedido' },
      }, required: ['codigo'] } } },
  ]
}
async function ordersExec(ctx, fnName, args) {
  try {
    const orders = require('../../services/orders')
    const r = await orders.toolCall(ctx.accId, fnName, args || {}, { convId: ctx.convId, agId: ctx.agId })
    // Envía las fotos del menú al chat (web + canal externo).
    for (const m of (r.media || [])) {
      const url = m.needsHost ? `${resourceBaseUrl()}${m.url}` : m.url
      await sendBotMsg(ctx, m.caption || '', { kind: 'image', media: { kind: 'image', url }, mediaUrl: url })
    }
    logDebug(ctx, 'tool_result', `🛵 Pedidos ${fnName}${r.orderCode ? ` → ${r.orderCode}` : ''}`, { media: (r.media || []).length })
    return r?.text || 'Hecho.'
  } catch (e) {
    logDebug(ctx, 'error', `Pedidos: ${e.message}`, {})
    return `No se pudo completar la acción de pedidos: ${e.message}`
  }
}

// Carga los turnos recientes para dar MEMORIA al agente. Descarta el/los turnos
// finales del usuario porque el nodo aporta su propio "mensaje actual".
async function loadHistory(ctx, limit = 16) {
  try {
    const convos = await store.readConvos(ctx.accId, ctx.agId)
    const conv = (convos || []).find(c => c.id === ctx.convId)
    const msgs = (conv?.messages || [])
      .filter(m => typeof m.content === 'string' && m.content.trim())
      .map(m => ({
        role: (m.sender === 'user' || m.role === 'user') ? 'user' : 'assistant',
        content: String(m.content),
      }))
    while (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop()
    return msgs.slice(-limit)
  } catch { return [] }
}

// ── Red de seguridad: "tool calls" escritas como TEXTO ─────────────────────────
// Algunos modelos (sobre todo DeepSeek) a veces NO usan el mecanismo de
// function-calling y en su lugar ESCRIBEN la llamada dentro del texto, p. ej.
// "...quedó claro. transferiraasesor()". Detectamos esos patrones contra las
// herramientas asignadas y las EJECUTAMOS de verdad, quitándolas del mensaje.
// Esto garantiza que la herramienta se active aunque el modelo falle el formato.
const normToolName = s => String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase()

function parseTextToolCalls(text, toolDefs) {
  const out = []
  if (!text || !Array.isArray(toolDefs) || !toolDefs.length) return out
  const byNorm = new Map()
  for (const t of toolDefs) { const n = t?.function?.name; if (n) byNorm.set(normToolName(n), n) }
  // nombre(args) — el nombre puede traer guiones bajos; args entre paréntesis
  const re = /([A-Za-zÁÉÍÓÚÑÜ_][\wÁÉÍÓÚÑÜáéíóúñü]*)\s*\(([^)]*)\)/g
  let m
  while ((m = re.exec(text))) {
    const real = byNorm.get(normToolName(m[1]))
    if (real) out.push({ name: real, args: parseTextArgs(m[2]), match: m[0] })
  }
  return out
}

function parseTextArgs(raw) {
  const s = String(raw || '').trim()
  if (!s) return {}
  try { if (s.startsWith('{')) return JSON.parse(s) } catch {}
  const obj = {}
  for (const part of s.split(',')) {
    const mm = part.match(/^\s*([\wÁÉÍÓÚÑáéíóúñ]+)\s*[:=]\s*([\s\S]*?)\s*$/)
    if (mm) obj[mm[1]] = mm[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return obj
}

async function callAI(ctx, { systemPrompt, userPrompt, model, provider, maxTokens = 800, temperature = 0.5, jsonMode = false, history = [], tools = [], onToolCall, onTools, onResolved }) {
  const prov = provider || detectProvider(model || 'gpt-4o-mini')
  const finalModel = model || DEFAULT_MODEL[prov] || 'gpt-4o-mini'
  const apiKey = getApiKey(ctx.account, prov)
  if (typeof onResolved === 'function') {
    onResolved({ provider: prov, model: finalModel, keySource: apiKey ? 'account' : 'none' })
  }
  if (!apiKey) throw new Error(`Sin API Key para ${prov}`)

  const onUsage = (u) => {
    try {
      store.recordTokenUsage(ctx.accId, {
        agentId: ctx.agId, conversationId: ctx.convId,
        provider: prov, model: finalModel,
        promptTokens: u?.promptTokens, completionTokens: u?.completionTokens,
        source: 'flow',
      })
    } catch {}
  }

  // Cuando hay herramientas, reforzamos por prompt que el modelo DEBE invocarlas
  // de verdad (function-calling) y nunca fingir en texto que ya ejecutó la acción.
  // Esto corrige el caso en que la IA "cree" que activó un trigger y solo responde
  // texto (frecuente en DeepSeek). Se combina con tool_choice:'auto' del cliente.
  let effSystem = systemPrompt

  // ── Conciencia temporal: se antepone a TODA respuesta conversacional (no en las
  // llamadas de utilidad en jsonMode: clasificar/enrutar/resumir). Así cualquier nodo
  // de IA (ai_agent, ai_chat, …) conoce la fecha y hora reales. La instrucción es
  // imperativa porque algunos modelos niegan por reflejo tener acceso a la hora.
  if (!jsonMode && ctx.account?.aiDatetimeEnabled !== false) {
    const tz = ctx.account?.aiTimezone || ctx.account?.scheduling?.timezone || 'America/Lima'
    const now = new Date()
    let localStr = '', utcStr = ''
    try { localStr = now.toLocaleString('es', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { localStr = now.toISOString() }
    try { utcStr = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' } catch { utcStr = '' }
    const temporalBlock = `🕐 FECHA Y HORA ACTUALES (dato en tiempo real que SÍ conoces):\n` +
      `• Ahora mismo es: ${localStr} (zona horaria ${tz}).\n` +
      `• Referencia UTC: ${utcStr}.\n` +
      `INSTRUCCIÓN OBLIGATORIA: SÍ tienes acceso a la fecha y la hora actuales (son las de arriba). ` +
      `Si te preguntan qué día es, la fecha o la hora —aquí o en cualquier ciudad/país del mundo— respóndela usando estos datos ` +
      `(calcula la diferencia horaria cuando pregunten por otra zona). ` +
      `NUNCA digas que no tienes acceso a la fecha o la hora, ni que no puedes saber la hora actual: SÍ la sabes.`
    effSystem = `${temporalBlock}\n\n---\n\n${effSystem || ''}`
    try { logDebug(ctx, 'flow_run', '🕐 Contexto temporal inyectado en el prompt', { timezone: tz, now: localStr }) } catch {}
  }

  if (tools.length > 0) {
    const toolNames = tools.map(t => t.function?.name).filter(Boolean).join(', ')
    // IMPORTANTE: partir de `effSystem` (que ya lleva antepuesto el bloque de FECHA Y
    // HORA actuales), NO de `systemPrompt`. Antes se reconstruía desde systemPrompt y
    // se PERDÍA la conciencia temporal justo cuando hay herramientas —el caso de la
    // agenda/disponibilidad—, lo que hacía que la IA no supiera la fecha/hora actual.
    effSystem = `${effSystem || ''}\n\n` +
      `── USO OBLIGATORIO DE HERRAMIENTAS ──\n` +
      `Tienes funciones/herramientas disponibles${toolNames ? ` (${toolNames})` : ''}. ` +
      `Cuando el usuario pida (o haga falta) una acción que una de estas herramientas realiza ` +
      `—enviar un archivo o recurso, guardar/registrar datos, crear/agendar/cancelar algo, disparar un flujo o proceso— ` +
      `DEBES ejecutarla llamando a la función mediante el mecanismo de tool-calling, NO escribiendo la acción en texto.\n` +
      `NUNCA escribas el nombre de la función dentro de tu respuesta (por ejemplo "transferir_a_asesor()" o "enviar_recurso(...)"): ` +
      `eso NO ejecuta nada y se ve como un error. Para ejecutar una herramienta, invócala por el canal de funciones, no como texto.\n` +
      `PROHIBIDO afirmar que ya hiciste algo ("ya lo envié", "lo guardé", "creé el ticket", "ejecuté el proceso", "listo, agendado") ` +
      `si en ESTE turno no invocaste realmente la función correspondiente. ` +
      `Si te falta algún dato para invocarla, pídeselo al usuario; nunca simules que la ejecutaste.`
  }

  const messages = []
  if (effSystem) messages.push({ role: 'system', content: effSystem })
  for (const h of history) {
    if (h?.content) messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content) })
  }
  messages.push({ role: 'user', content: userPrompt })

  // ── Con herramientas → PROTOCOLO MULTI-RONDA (estándar) ───────────────────
  // El modelo llama herramienta(s) → ejecutamos → le devolvemos el resultado como
  // mensaje `tool` → vuelve a responder (texto final u otra herramienta). No
  // re-alimentar el resultado (lo que se hacía antes) confunde a algunos modelos
  // (DeepSeek) y hace que la herramienta "se active solo una vez". Anthropic no
  // soporta este hilo en nuestro builder → mantiene una sola ronda.
  if (tools.length > 0) {
    const canThread = prov !== 'anthropic'
    const convo = messages.slice()
    const executed = []
    // Headroom para varios triggers consecutivos (cada uno consume una ronda)
    // + la respuesta final del modelo.
    const MAX_ROUNDS = 6

    // Ejecuta herramientas que el modelo haya ESCRITO en el texto (red de
    // seguridad) y devuelve el texto ya limpio de esas llamadas.
    const runTextCalls = async (text) => {
      const found = parseTextToolCalls(text, tools)
      if (!found.length) return text
      let cleaned = text
      for (const c of found) {
        logDebug(ctx, 'tool_call', `🔧 Herramienta (texto): ${c.name}`, c.args)
        const r = onToolCall ? await onToolCall(c.name, c.args) : 'OK'
        logDebug(ctx, 'tool_result', `✅ Resultado: ${c.name}`, r)
        executed.push(c.name)
        cleaned = cleaned.split(c.match).join('')
      }
      return cleaned.replace(/\n{3,}/g, '\n\n').trim()
    }
    const finishText = async (text) => {
      let clean = await runTextCalls(text || '')
      // Si se ejecutaron herramientas pero el modelo NO redactó respuesta (caso
      // típico de DeepSeek: llama la función y devuelve vacío), forzamos una
      // redacción final SIN herramientas usando los resultados ya añadidos a la
      // conversación, para que SIEMPRE responda en base a la info obtenida.
      if (!clean && executed.length && canThread) {
        try {
          const synth = await chat({ provider: prov, model: finalModel, apiKey, messages: convo, maxTokens, temperature, onUsage })
          if (typeof synth === 'string' && synth.trim()) clean = synth.trim()
        } catch (e) { logDebug(ctx, 'error', `Síntesis post-herramienta falló: ${e.message}`, {}) }
      }
      if (typeof onTools === 'function') onTools({ invoked: executed.length > 0, names: executed })
      return clean
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await chat({ provider: prov, model: finalModel, apiKey, messages: convo, tools, maxTokens, temperature, onUsage })
      if (typeof result === 'string') {
        return await finishText(result)
      }
      const message = result?.message
      const toolCalls = message?.tool_calls || []
      if (!toolCalls.length) {
        return await finishText(typeof message?.content === 'string' ? message.content : '')
      }
      if (canThread) convo.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls })
      for (const tc of toolCalls) {
        let args = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch {}
        const name = tc.function?.name
        logDebug(ctx, 'tool_call', `🔧 Herramienta: ${name}`, args)
        const r = onToolCall ? await onToolCall(name, args) : 'OK'
        logDebug(ctx, 'tool_result', `✅ Resultado: ${name}`, r)
        executed.push(name)
        if (canThread) convo.push({ role: 'tool', tool_call_id: tc.id, content: typeof r === 'string' ? r : JSON.stringify(r ?? '') })
      }
      if (!canThread) { // Anthropic: comportamiento previo (una ronda, sin re-alimentar)
        if (typeof onTools === 'function') onTools({ invoked: true, names: executed })
        return ''
      }
      // openai/deepseek → siguiente ronda con los resultados en contexto
    }
    // Se agotaron las rondas: redacta una respuesta final con los resultados.
    return await finishText('')
  }

  // ── Sin herramientas → completion simple ─────────────────────────────────
  const response = await chat({
    provider: prov, model: finalModel, apiKey, messages,
    maxTokens, temperature,
    advanced: jsonMode ? { responseFormat: { type: 'json_object' } } : {},
    onUsage,
  })
  return response || ''
}

const aiNodes = [
  {
    type: 'ai_agent', category: 'ai', label: 'Agente IA',
    async exec(node, ctx) {
      // Enforcement de suscripción: límites Demo (7d/100/30), mensuales, gracia,
      // suspensión. Si la cuenta está bloqueada, enviamos el mensaje del límite y
      // detenemos el flujo (no se genera respuesta de IA ni se consume).
      try {
        const subs = require('../../services/subscriptions')
        const gate = await subs.assistantGate(ctx.accId, ctx.convId)
        if (!gate.allowed) {
          // Límite de respuestas IA por chat (Demo): NO se envía nada al contacto;
          // el gate ya desactivó la IA en la conversación. Solo se registra.
          if (gate.disableAi) {
            logDebug(ctx, 'flow_run', `🚫 IA desactivada en este chat: alcanzó el límite de ${gate.max} respuestas IA`, { reason: gate.reason })
            ctx._suppressDefaultNext = true
            return
          }
          // Otros límites (suspensión, demo vencida, 100 conversaciones, plan):
          // el mensaje se envía UNA sola vez por conversación (evita spam).
          const already = ctx.variables?._limitNotified
          if (!already && gate.message) {
            await sendBotMsg(ctx, gate.message)
            await setVarBoth(ctx, '_limitNotified', '1')
          }
          if (gate.closeConv) await subs.closeConversation(ctx.accId, ctx.convId)
          logDebug(ctx, 'flow_run', '🚫 Límite de suscripción alcanzado', { message: gate.message })
          ctx._suppressDefaultNext = true
          return
        }
      } catch (e) { logDebug(ctx, 'error', `enforcement no disponible: ${e.message}`, {}) }

      const mode = node.data?.promptMode || 'inline'
      let systemPrompt = ''
      let model = node.data?.modelo || 'gpt-4o-mini'
      let provider
      let temperature = Number(node.data?.temperatura ?? 0.5)
      let promptLabel = 'inline'
      let assignedTools = []
      let ragFileIds = null   // archivos de conocimiento asignados al prompt (null = sin asignación explícita)

      if (mode === 'active' || mode === 'from_list') {
        const allPrompts = ctx.account?.agents?.flatMap(a => a.prompts || []) || []
        const chosen = mode === 'active'
          ? allPrompts.find(p => p.isActive)
          : allPrompts.find(p => p.id === node.data?.promptId)
        if (!chosen) {
          const msg = mode === 'active'
            ? 'Agente IA: no hay ningún prompt marcado como activo en el agente.'
            : `Agente IA: el prompt seleccionado (${node.data?.promptId || '—'}) ya no existe.`
          logDebug(ctx, 'error', `⚠ ${msg}`, { mode })
          throw new Error(msg)
        }
        systemPrompt = chosen.content || ''
        provider = chosen.provider || undefined
        model    = chosen.model || undefined
        const t = chosen.advanced?.temperature ?? chosen.temperature
        if (t != null) temperature = Number(t)
        promptLabel = chosen.name || '(sin nombre)'
        const toolIds = chosen.toolIds || []
        assignedTools = (ctx.account?.aiTools || []).filter(t => toolIds.includes(t.id))
        if (Array.isArray(chosen.ragFileIds)) ragFileIds = chosen.ragFileIds
      } else {
        systemPrompt = interpolate(node.data?.prompt || '', ctx.variables)
      }

      const objetivo = interpolate(node.data?.objetivo || '', ctx.variables)
      const sys = [systemPrompt, objetivo && `OBJETIVO: ${objetivo}`].filter(Boolean).join('\n\n')

      const fallbackMsg = ctx.variables?._lastUserMessage || ctx.variables?.message || ''
      let userMsg = fallbackMsg
      const rawField = node.data?.mensajeUsuario
      if (rawField !== undefined && rawField !== '') {
        const interpolated = interpolate(rawField, ctx.variables)
        userMsg = (interpolated && !/^\{\{.*\}\}$/.test(interpolated.trim())) ? interpolated : fallbackMsg
      }
      // Mensaje citado (responder/reply): se lo damos de contexto al modelo. Útil
      // cuando el usuario solo pone un "." para referirse a un mensaje anterior.
      const quoted = ctx.variables?._quotedMessage
      if (quoted && String(quoted).trim()) {
        const u = (userMsg || '').trim()
        userMsg = `[El usuario está respondiendo a este mensaje anterior: "${String(quoted).trim()}"]\n\n` +
          (u ? `Mensaje del usuario: ${u}` : 'El usuario no escribió texto; responde basándote en el mensaje citado.')
      }

      // Auto-RAG: si el agente tiene base de conocimiento activa, recupera el
      // contexto relevante y lo añade al system prompt. Los embeddings usan la key
      // EFECTIVA de OpenAI (cuenta o plataforma), así que funciona con cualquier
      // proveedor de chat — incluido DeepSeek, que no tiene embeddings propios.
      // Conocimiento (RAG): se usa SOLO los archivos asignados al prompt activo
      // (como las Herramientas IA). Si el prompt no define asignación (campo
      // ausente, prompts antiguos) y RAG global está activo, usa todos (compat).
      let sysWithRag = sys
      try {
        const ag = ctx.account?.agents?.find(a => a.id === ctx.agId)
        const allFiles = (ag?.rag?.files || []).map(f => f.id)
        let useFileIds = null
        if (Array.isArray(ragFileIds)) useFileIds = ragFileIds.filter(id => allFiles.includes(id))
        else if (ag?.rag?.enabled && allFiles.length) useFileIds = allFiles
        if (useFileIds && useFileIds.length && ctx.account?.openaiKey) {
          const { buildRagContext } = require('../../services/rag')
          const ragQuery = String(ctx.variables?._lastUserMessage || ctx.variables?.message || userMsg || '').slice(0, 1000)
          const ragBlock = await buildRagContext(ragQuery, ctx.accId, ctx.agId, ctx.account.openaiKey, useFileIds)
          if (ragBlock) { sysWithRag = `${sys}\n${ragBlock}`; logDebug(ctx, 'flow_run', '📚 Conocimiento (RAG) inyectado en el prompt', { files: useFileIds.length }) }
        }
      } catch (e) { logDebug(ctx, 'error', `RAG no disponible: ${e.message}`, {}) }

      // Memoria PERMANENTE del cliente (resumen + estado de lo hablado, también de
      // conversaciones pasadas). Se inyecta además de los últimos 16 mensajes.
      const _mem = ctx.variables?._summary
      if (_mem && String(_mem).trim()) {
        sysWithRag = `${sysWithRag}\n\n---\n[MEMORIA DEL CLIENTE — resumen permanente de lo hablado y datos importantes; úsala para personalizar y no volver a preguntar lo que ya sabes]\n${String(_mem).trim()}\n---`
      }

      // Cliente recurrente: ya había conversado antes (contacto conocido o historial
      // sincronizado por Coexistencia). Evita que el asistente lo trate como nuevo y
      // rompa el hilo — incluso si no hay historial dentro de la ventana de mensajes.
      // El texto es configurable: override por canal (_returningNotice) → default de
      // la plataforma (super admin) → constante interna como último recurso.
      if (ctx.variables?._returning) {
        const notice = (ctx.variables?._returningNotice && String(ctx.variables._returningNotice).trim())
          || (ctx.account?.returningNoticeDefault && String(ctx.account.returningNoticeDefault).trim())
          || DEFAULT_RETURNING_NOTICE
        sysWithRag = `${sysWithRag}\n\n---\n[CLIENTE RECURRENTE] ${notice}${_mem && String(_mem).trim() ? ' Apóyate en la memoria del cliente de arriba.' : ''}\n---`
      }

      // (La conciencia temporal general se inyecta ahora dentro de callAI, para que
      //  la reciba CUALQUIER nodo de IA conversacional, no solo este.)

      // Conciencia temporal para la agenda: el modelo necesita saber qué día es hoy.
      const _sch = ctx.account?.scheduling
      if (_sch?.connected) {
        let hoy = ''
        try { hoy = new Date().toLocaleDateString('es-CO', { timeZone: _sch.timezone || 'America/Lima', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) } catch { hoy = new Date().toISOString().slice(0, 10) }
        sysWithRag = `${sysWithRag}\n\n📅 HOY es ${hoy} (zona horaria ${_sch.timezone || 'America/Lima'}). Para citas usa SIEMPRE la herramienta de agenda (ver_disponibilidad / recomendar_citas / agendar_cita / mover_cita / cancelar_cita); NO inventes horarios ni confirmes citas sin la herramienta.`
      }

      // Recontacto: si el flujo se disparó como recontacto inteligente, inyecta la
      // instrucción para que el agente RETOME la conversación donde quedó (en vez de
      // saludar desde cero), usando su prompt/conocimiento/herramientas reales.
      const _recon = ctx.variables?._recontactInstruction
      if (_recon && String(_recon).trim()) {
        sysWithRag = `${sysWithRag}\n\n---\n[RECONTACTO] ${String(_recon).trim()}\n---`
      }

      const history = await loadHistory(ctx)
      const toolDefs = buildToolDefs(assignedTools, ctx.account)

      let resolved = null
      let toolsInvoked = false
      const reply = await callAI(ctx, {
        systemPrompt: sysWithRag,
        userPrompt: userMsg || '(sin contexto del usuario, responde con un saludo)',
        model, provider, history, tools: toolDefs,
        onToolCall: (name, args) => execToolCall(ctx, assignedTools, name, args),
        onTools: info => { toolsInvoked = info.invoked },
        maxTokens: 800, temperature,
        onResolved: r => { resolved = r },
      })

      logDebug(ctx, 'flow_run',
        `🤖 Agente IA · ${resolved?.provider || provider || '?'} · ${resolved?.model || model || '?'}`,
        { promptMode: mode, prompt: promptLabel, temperature, turnosDeHistorial: history.length,
          herramientas: assignedTools.map(t => t.name), herramientaActivada: toolsInvoked,
          mensajeUsuario: (userMsg || '').slice(0, 200) })

      if (toolsInvoked) {
        // Tras usar una herramienta, ENTREGAMOS la respuesta del modelo
        // directamente al usuario y detenemos el flujo. No dependemos de un nodo
        // de mensaje posterior ({{respuesta_ia}}), que según el flujo puede no
        // existir (p. ej. un agente con un solo nodo IA) y haría que la respuesta
        // se pierda. La guardamos también en la variable destino por si se usa.
        logDebug(ctx, 'flow_run', '🔧 Herramienta IA activada' + (reply ? ' (+ respuesta final)' : ''), {})
        if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, reply || '')
        if (reply) await sendBotMsg(ctx, reply)
        scheduleMemory(ctx)
        ctx._suppressDefaultNext = true
        return
      }

      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, reply)
      if (node.data?.sendToUser !== false && reply) await sendBotMsg(ctx, reply)
      scheduleMemory(ctx)
    },
  },
  {
    type: 'ai_chat', category: 'ai', label: 'Chat IA',
    async exec(node, ctx) {
      const sys = interpolate(node.data?.prompt || '', ctx.variables)
      const history = await loadHistory(ctx)
      const reply = await callAI(ctx, {
        systemPrompt: sys, userPrompt: ctx.variables?._lastUserMessage || '',
        model: node.data?.modelo, maxTokens: 600, history,
      })
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, reply)
      else if (reply) await sendBotMsg(ctx, reply)
    },
  },
  {
    type: 'intent_classifier', category: 'ai', label: 'Clasificador de intención',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '{{_lastUserMessage}}', ctx.variables)
      const intents = String(node.data?.intents || '').split(',').map(s => s.trim()).filter(Boolean)
      if (!txt || !intents.length) throw new Error('Falta texto o intents')
      const sys = `Eres un clasificador. Dado el texto, elige UNA intent de la lista: ${intents.join(', ')}.
Responde SOLO JSON: {"intent":"<una de la lista>","confidence":0.0-1.0}`
      const raw = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 100, temperature: 0, jsonMode: true })
      let parsed = { intent: intents[0], confidence: 0 }
      try { parsed = JSON.parse(raw) } catch {}
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, parsed.intent)
      ctx.variables._last_intent = parsed.intent
      ctx.variables._last_intent_confidence = parsed.confidence
      logDebug(ctx, 'flow_run', `🎯 Intent: ${parsed.intent} (${(parsed.confidence * 100).toFixed(0)}%)`, parsed)
    },
  },
  {
    type: 'entity_extractor', category: 'ai', label: 'Extractor de entidades',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const entities = String(node.data?.entidades || '').split(',').map(s => s.trim()).filter(Boolean)
      const sys = `Extrae las siguientes entidades del texto. Devuelve SOLO JSON con esas claves; valor null si no aparece. Claves: ${entities.join(', ')}.`
      const raw = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 300, temperature: 0, jsonMode: true })
      let parsed = {}
      try { parsed = JSON.parse(raw) } catch {}
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, JSON.stringify(parsed))
      for (const [k, v] of Object.entries(parsed)) { if (v != null) ctx.variables[`entity_${k}`] = v }
      logDebug(ctx, 'flow_run', '🧩 Entidades extraídas', parsed)
    },
  },
  {
    type: 'sentiment_analyzer', category: 'ai', label: 'Sentimiento',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const sys = 'Clasifica el sentimiento del texto. Devuelve SOLO JSON: {"sentiment":"positive|neutral|negative","score":-1.0 a 1.0}'
      const raw = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 80, temperature: 0, jsonMode: true })
      let parsed = { sentiment: 'neutral', score: 0 }
      try { parsed = JSON.parse(raw) } catch {}
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, parsed.sentiment)
      ctx.variables._last_sentiment = parsed.sentiment
      ctx.variables._last_sentiment_score = parsed.score
    },
  },
  {
    type: 'summarizer', category: 'ai', label: 'Resumidor',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const longitud = node.data?.longitud || 'mediano'
      const sys = `Resume el texto en español. Formato: ${longitud}.`
      const summary = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 400 })
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, summary)
      else await sendBotMsg(ctx, summary)
    },
  },
  {
    type: 'rewriter', category: 'ai', label: 'Reescritor',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const tono = node.data?.tono || 'informal'
      const sys = `Reescribe el siguiente texto con tono ${tono}. Mantén el sentido. Devuelve SOLO el texto reescrito.`
      const out = await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 400 })
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, out)
      else await sendBotMsg(ctx, out)
    },
  },
  {
    type: 'ai_router', category: 'ai', label: 'Router IA',
    async exec(node, ctx) {
      const txt = interpolate(node.data?.texto || '', ctx.variables)
      const rutas = String(node.data?.rutas || '').split(',').map(s => s.trim()).filter(Boolean)
      if (!rutas.length) throw new Error('Define al menos una ruta')
      const sys = `Eres un router. Elige UNA de estas rutas: ${rutas.join(', ')}.\nResponde SOLO el nombre exacto.`
      const choice = (await callAI(ctx, { systemPrompt: sys, userPrompt: txt, model: node.data?.modelo, maxTokens: 16, temperature: 0 })).trim().toLowerCase()
      const winner = rutas.find(r => r.toLowerCase() === choice) || rutas[0]
      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, winner)
      ctx.variables._last_route = winner
      logDebug(ctx, 'flow_run', `🛤 Router IA → ${winner}`, { rutas })
    },
  },
]

module.exports = { aiNodes, callAI, execToolCall, buildToolDefs }
