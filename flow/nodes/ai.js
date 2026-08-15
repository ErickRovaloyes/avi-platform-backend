'use strict'
/**
 * AI category (backend port) — agente IA con memoria, clasificadores y utilidades.
 * Usa services/aiClient.chat con las keys efectivas de ctx.account.
 */

const { chat, detectProvider, getApiKey, OPENAI_DEFAULT, DEEPSEEK_DEFAULT } = require('../../services/aiClient')
const { interpolate, sendBotMsg, logDebug, setVarBoth } = require('../common')
const store = require('../store')

// Modelo por defecto de cada proveedor cuando el prompt no fija uno. Sale de aiClient para
// que exista un único sitio donde cambiarlo (antes OpenAI caía en el viejo 'gpt-4o-mini').
const DEFAULT_MODEL = { openai: OPENAI_DEFAULT, deepseek: DEEPSEEK_DEFAULT }
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
    else if (tool.actionType === 'woocommerce') { if (account?.woocommerce?.connected) defs.push(...buildWooToolDefs(account)) }
    else if (tool.actionType === 'scheduling') { if (account?.scheduling?.connected) defs.push(...buildAgendaToolDefs(account)) }
    else if (tool.actionType === 'payment') { if (account?.payments?.connected) defs.push(...buildPaymentToolDefs()) }
    else if (tool.actionType === 'meta_catalog') { if (account?.metaCatalog?.connected) defs.push(...buildCatalogToolDefs()) }
    else if (tool.actionType === 'pms') { if (account?.pms?.connected) defs.push(...buildPmsToolDefs(account)) }
    else if (tool.actionType === 'orders') { if (account?.orders?.connected) defs.push(...buildOrdersToolDefs(account)) }
    else if (tool.actionType === 'data_tables') { if (account?.dataTables?.connected) defs.push(...buildDataTableToolDefs(account)) }
    else if (tool.actionType === 'recontact') { defs.push(...buildRecontactToolDefs()) }
    else if (tool.actionType === 'labels') { defs.push(...buildLabelToolDefs(account)) }
    else if (tool.actionType === 'pipeline') { defs.push(...buildPipelineToolDefs(account)) }
    else if (tool.actionType === 'variables') { defs.push(...buildVariableToolDefs(account)) }
    else if (tool.actionType === 'tasks') { defs.push(...buildTaskToolDefs(account)) }
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
  // Tablas internas del cliente.
  if (RECONTACT_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'recontact')) {
    return recontactExec(ctx, normalized, toolArgs)
  }
  if (LABEL_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'labels')) {
    return labelExec(ctx, normalized, toolArgs)
  }
  if (PIPELINE_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'pipeline')) {
    return pipelineExec(ctx, normalized, toolArgs)
  }
  if (VARIABLE_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'variables')) {
    return variableExec(ctx, toolArgs)
  }
  if (TASK_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'tasks')) {
    return taskExec(ctx, toolArgs)
  }
  if (DATATABLE_FUNCS.has(normalized) && (toolList || []).some(t => t.actionType === 'data_tables')) {
    return dataTableExec(ctx, normalized, toolArgs)
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
    // parentCtx: hereda el canal de salida y devuelve el nº de mensajes enviados, para que el
    // nodo Agente IA no vuelva a enviar su propio texto encima (doble respuesta).
    await executeFlow({
      flowId: tool.flowId, accId: ctx.accId, agId: ctx.agId, convId: ctx.convId,
      triggerContext: { tool: tool.name, args: toolArgs }, parentCtx: ctx,
    })
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

// Cuántas fotos de cada producto se listan en la descripción de la herramienta.
const MAX_UNIT_PHOTOS_LISTED = 12

// Fotos de una carpeta "super unidad" EN EL ORDEN QUE FIJÓ EL NEGOCIO. `sortOrder` lo
// establece el dueño arrastrando en el CMS; el nombre desempata para que dos fotos sin
// posición no salgan en orden aleatorio entre recargas.
function unitAssets(assets, folder) {
  return assets
    .filter(a => a.folderId === folder.id)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name)))
}

// Traduce los nombres que pidió el modelo a los archivos reales, CONSERVANDO SU ORDEN.
// Se apoya en pickBest porque el modelo suele escribir el nombre aproximado ("la fachada" por
// "Fachada principal.jpg"). Un nombre que no resuelva se OMITE en silencio: es mejor enviar
// las que sí entendimos que abortar el envío entero por una palabra.
// No repite archivos aunque el modelo nombre el mismo dos veces.
function resolveOrder(items, names) {
  const out = []
  const used = new Set()
  for (const raw of names) {
    const pool = items.filter(a => !used.has(a.id))
    if (!pool.length) break
    const best = pickBest(pool, tokenize(String(raw)))
    if (best.asset && best.score >= 1) { out.push(best.asset); used.add(best.asset.id) }
  }
  return out
}
function buildResourceToolDef(account) {
  const assets = account?.cmsAssets || []
  const folders = account?.cmsFolders || []
  if (!assets.length) return null
  const unitFolders = folders.filter(f => f.type === 'unit' && assets.some(a => a.folderId === f.id))
  const lines = []
  if (unitFolders.length) {
    lines.push('PRODUCTOS / SERVICIOS (cada uno agrupa varias fotos — al pedirlo se envían todas, o solo las que indiques en "fotos"):')
    unitFolders.forEach(f => {
      // Se listan las fotos de cada producto para que el modelo pueda NOMBRARLAS y así elegir
      // cuáles manda y en qué orden. Antes solo se listaba el producto, así que no tenía forma
      // de referirse a una foto concreta. Tope por producto: el mismo motivo que el slice(0,60)
      // de los recursos sueltos — no inflar el prompt en cuentas con muchas imágenes.
      const items = unitAssets(assets, f)
      const names = items.slice(0, MAX_UNIT_PHOTOS_LISTED).map(a => a.name).join(', ')
      const extra = items.length > MAX_UNIT_PHOTOS_LISTED ? `, +${items.length - MAX_UNIT_PHOTOS_LISTED} más` : ''
      // El dueño decide por producto quién manda en el orden. Se le dice al modelo cuál es su
      // papel en cada uno para que no reordene donde no debe.
      const modo = f.photoOrder === 'ai'
        ? ' [TÚ eliges el orden: ponlas según tu prompt y lo que pida el cliente]'
        : ' [orden fijado por el negocio: envíalas tal cual salvo que el cliente pida otra cosa]'
      lines.push(`• ${f.name}${f.description ? ` — ${f.description}` : ''} → fotos: ${names}${extra}${modo}`)
    })
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
      description: `Envía al usuario imágenes o documentos del CMS. Úsalo cuando el usuario los pida o cuando ayuden (catálogo, lista de precios, foto de un producto/servicio, folleto, manual…). En "recurso" indica el producto/servicio o recurso de esta lista.\n`
        + `Si es un PRODUCTO/SERVICIO, cada uno indica entre corchetes quién decide el orden de sus fotos:\n`
        + `· "orden fijado por el negocio" → deja "fotos" vacío y se enviarán todas en el orden establecido. Solo usa "fotos" si el cliente pide expresamente algo concreto.\n`
        + `· "TÚ eliges el orden" → DEBES rellenar "fotos" con los nombres en el orden que consideres mejor. Decídelo con el criterio de tus instrucciones (tu prompt) y con lo que el cliente esté buscando: primero lo que más le va a interesar. Puedes enviar solo las relevantes en vez de todas.\n`
        + `Usa "detalle" (en vez de "fotos") cuando el cliente pida un aspecto puntual y baste UNA sola foto.\n${lines.join('\n')}`,
      parameters: {
        type: 'object',
        properties: {
          recurso: { type: 'string', description: 'Producto/servicio o recurso a enviar (lo más parecido de la lista).' },
          fotos: {
            type: 'array',
            items: { type: 'string' },
            description: 'Opcional: nombres de las fotos de ese producto, EN EL ORDEN en que quieres enviarlas. Se envían solo esas. Si lo omites se envían todas.',
          },
          detalle: { type: 'string', description: 'Opcional: aspecto/foto concreta que pide el usuario dentro de ese producto (envía una sola).' },
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
  const orden = Array.isArray(args?.fotos) ? args.fotos.filter(x => String(x || '').trim()) : []
  const recTokens = tokenize(recurso)

  // 1) ¿"recurso" coincide con una carpeta (producto/servicio)?
  const folderScored = folders
    // `unitAssets` respeta el orden manual del CMS: si no se pide otra cosa, las fotos
    // salen tal como el negocio las colocó.
    .map(f => ({ f, score: scoreText(recTokens, f.name) + scoreText(recTokens, f.description || ''), items: unitAssets(assets, f) }))
    .filter(x => x.items.length)
    .sort((a, b) => b.score - a.score)
  const topFolder = folderScored[0]
  if (topFolder && topFolder.score >= 2) {
    const { f, items } = topFolder
    if (f.type === 'unit' && !detalle.trim()) {
      // Con "fotos" el modelo elige cuáles y en qué orden; sin ella, todas (lo de siempre).
      const chosen = orden.length ? resolveOrder(items, orden) : items
      if (!chosen.length) {
        // El modelo pidió fotos que no supimos resolver: mejor enviar todas que nada.
        logDebug(ctx, 'tool_result', `📎 Ninguna foto coincidió con ${JSON.stringify(orden)}; se envían todas`, {})
        for (let i = 0; i < items.length; i++) await sendOneAsset(ctx, items[i], i === 0 ? caption : '')
        return `Te envié ${items.length} archivo(s) de "${f.name}".`
      }
      for (let i = 0; i < chosen.length; i++) await sendOneAsset(ctx, chosen[i], i === 0 ? caption : '')
      const quien = orden.length
        ? (f.photoOrder === 'ai' ? ' en el orden que elegiste' : ' en el orden pedido')
        : ' en el orden fijado en el CMS'
      const detail = `${quien} (${chosen.map(a => a.name).join(' → ')})`
      logDebug(ctx, 'tool_result', `📎 Enviadas ${chosen.length} fotos de "${f.name}"${detail}`, { photoOrder: f.photoOrder || 'manual' })
      return `Te envié ${chosen.length} archivo(s) de "${f.name}"${detail}.`
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
/**
 * Respuesta a una búsqueda SIN resultados.
 *
 * "No encontré productos" a secas es el hueco donde el modelo se inventa un producto
 * parecido, que es exactamente el fallo reportado. Devolver las categorías que SÍ existen
 * le da con qué ofrecer alternativas reales, y le recuerda que no puede tirar de memoria.
 */
async function emptySearchHint(accId, consulta, cargarCategorias) {
  let cats = []
  try { cats = await cargarCategorias() } catch { cats = [] }
  const base = `No hay ningún producto que coincida con "${consulta}" en el catálogo.`
  if (!cats.length) {
    return `${base} NO inventes ni sugieras productos: dile con naturalidad que eso no lo manejan y pregúntale qué más necesita.`
  }
  return `${base} Lo que SÍ hay en el catálogo son estas categorías: ${cats.join(', ')}.`
    + ' Ofrécele alternativas SOLO de esas categorías, y búscalas primero con buscar_productos para confirmar precio y disponibilidad. NO menciones ningún producto que no hayas buscado.'
}

/**
 * Normaliza lo que manda la IA a una lista de líneas `{ nombre, cantidad }`.
 *
 * Acepta la forma nueva (`items: [{producto, cantidad}]`) y la antigua (`producto` y
 * `cantidad` sueltos), porque un modelo puede seguir usando la vieja: el molde guía,
 * no obliga. Sin esta tolerancia, un despiste del modelo dejaría al cliente sin pedido.
 */
function normalizeOrderItems(args) {
  const crudas = Array.isArray(args?.items) && args.items.length
    ? args.items
    : (args?.producto ? [{ producto: args.producto, cantidad: args.cantidad }] : [])
  const out = []
  for (const it of crudas) {
    // El modelo a veces manda la línea como texto suelto en vez de objeto.
    const nombre = String((typeof it === 'string' ? it : it?.producto ?? it?.nombre) || '').trim()
    if (!nombre) continue
    const cantidad = Math.max(1, parseInt(typeof it === 'string' ? 1 : it?.cantidad, 10) || 1)
    out.push({ nombre, cantidad })
  }
  return out
}

/**
 * Resuelve cada línea contra el buscador de productos.
 *
 * Devuelve las líneas resueltas y los nombres que NO se encontraron. Quien llama decide
 * qué hacer con los fallos; aquí no se crea nada a medias.
 *
 * Las líneas que resuelven al MISMO producto se fusionan sumando cantidades: si el
 * cliente dice "dos camisas y otra camisa más", debe salir una línea de 3, no dos líneas
 * del mismo artículo en la misma factura.
 */
async function resolveOrderLines(pedidas, buscar) {
  const lineas = []
  const faltantes = []
  const porClave = new Map()
  for (const { nombre, cantidad } of pedidas) {
    let encontrado = null
    try { encontrado = (await buscar(nombre))?.[0] || null } catch { encontrado = null }
    if (!encontrado) { faltantes.push(nombre); continue }
    const clave = `${encontrado.id}|${encontrado.variantId || ''}`
    const ya = porClave.get(clave)
    if (ya) { ya.cantidad += cantidad; continue }
    const linea = { product: encontrado, cantidad, pedido: nombre }
    porClave.set(clave, linea)
    lineas.push(linea)
  }
  return { lineas, faltantes }
}

const WOO_FUNCS = new Set(['buscar_productos', 'enviar_producto', 'crear_pedido', 'ver_pedido'])
function buildWooToolDefs(account) {
  const storeSvc = require('../../services/store')
  const fields = account?.woocommerce?.orderForm || []
  const labels = storeSvc.ORDER_FIELD_LABELS
  // UN pedido puede llevar VARIOS productos. Antes el molde solo tenía sitio para uno
  // (`producto` + `cantidad`), así que ante "quiero A y B" el modelo o llamaba dos veces
  // —dos pedidos y dos links de pago— o se dejaba un producto fuera. Ambos síntomas
  // reportados salían de aquí. `producto`/`cantidad` se conservan por compatibilidad:
  // si un modelo los manda sueltos, se convierten en una lista de un elemento.
  const pedidoProps = {
    items: {
      type: 'array',
      description: 'TODOS los productos del pedido. Si el cliente pide varios, van TODOS aquí en una sola llamada: NO llames a esta herramienta más de una vez.',
      items: {
        type: 'object',
        properties: {
          producto: { type: 'string', description: 'Nombre del producto' },
          cantidad: { type: 'integer', description: 'Unidades (por defecto 1)' },
        },
        required: ['producto'],
      },
    },
    producto: { type: 'string', description: 'OBSOLETO: usa "items". Solo para pedidos de un único producto.' },
    cantidad: { type: 'string', description: 'OBSOLETO: cantidad del campo "producto".' },
  }
  // Cada dato configurado se expone como parámetro; la validación de OBLIGATORIOS se
  // hace en el servidor (más fiable que marcarlos required en el schema).
  for (const f of fields) {
    if (!labels[f.key]) continue
    pedidoProps[f.key] = { type: 'string', description: `${labels[f.key]} del cliente${f.required ? ' (OBLIGATORIO: si no lo tienes, PÍDESELO al cliente antes de crear el pedido)' : ' (si lo tienes)'}` }
  }
  const req = fields.filter(f => f.required && labels[f.key]).map(f => labels[f.key])
  const pedidoDesc = 'Crea UN pedido en la tienda y envía al usuario UN ÚNICO link de pago. Úsalo SOLO cuando el usuario confirme que quiere comprar.'
    + ' Si el cliente pide VARIOS productos, inclúyelos TODOS en "items" en UNA SOLA llamada — nunca llames varias veces, porque generarías varios pedidos y varios links de pago.'
    + (req.length ? ` ANTES debes tener estos datos del cliente (pídeselos si faltan): ${req.join(', ')}.` : '')
    + ' Tras el pago, se confirma automáticamente.'
  // Si la gestión de pedidos está desactivada, la IA solo consulta productos y
  // estado de pedidos; NO puede crear pedidos (los gestiona un humano).
  const ordersOff = account?.woocommerce?.ordersEnabled === false
  const defs = [
    { type: 'function', function: { name: 'buscar_productos',
      description: 'Consulta el catálogo REAL de la tienda. Es tu ÚNICA fuente sobre qué se vende: tú no sabes qué hay en stock.\n'
        + 'ÚSALA SIEMPRE ANTES DE RESPONDER cuando el cliente:\n'
        + '· pregunte por un producto, su precio o su disponibilidad;\n'
        + '· exprese una NECESIDAD, un problema, un gusto o una situación, aunque no nombre ningún producto. Ejemplos: "tengo calor" → busca "ventilador aire acondicionado refrescante"; "no duermo bien" → busca "almohada colchón descanso"; "busco un regalo para mi mamá" → busca "regalo"; "algo para la lluvia" → busca "impermeable paraguas".\n'
        + 'NUNCA recomiendes ni menciones un producto que no haya salido de esta búsqueda: no puedes saber si existe. Si dudas, busca.',
      parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'Palabras clave de lo que necesita el cliente. Si expresó una necesidad y no un producto, traduce la necesidad a los productos que podrían resolverla.' } }, required: ['consulta'] } } },
    { type: 'function', function: { name: 'enviar_producto',
      description: 'Envía al usuario un producto con sus FOTOS y una ficha (nombre, precio, link). Úsalo cuando el usuario quiera VER un producto o pida su foto/presentación/catálogo.',
      parameters: { type: 'object', properties: { producto: { type: 'string', description: 'Nombre o palabras clave del producto a enviar' } }, required: ['producto'] } } },
    ...(ordersOff ? [] : [{ type: 'function', function: { name: 'crear_pedido',
      description: pedidoDesc,
      parameters: { type: 'object', properties: pedidoProps, required: ['items'] } } }]),
    { type: 'function', function: { name: 'ver_pedido',
      description: 'Consulta el ESTADO actual de un pedido en la tienda (seguimiento). Úsalo cuando el cliente pregunte por su pedido, envío o estado. Si no da el número, se usa el último pedido de esta conversación.',
      parameters: { type: 'object', properties: {
        numero_pedido: { type: 'string', description: 'Número/ID del pedido (opcional; si no, se usa el último de la conversación)' },
      } } } },
  ]
  return defs
}
async function wooExec(ctx, fnName, args) {
  const store = require('../../services/store')
  const accId = ctx.accId
  const cfg = await store.loadConfig(accId)
  const maxImgs = store.maxImages(cfg)
  try {
    if (fnName === 'buscar_productos') {
      const list = await store.searchProductsSmart(accId, args?.consulta || args?.query || '')
      if (!list.length) return await emptySearchHint(accId, args?.consulta || args?.query || '', () => require('../../services/productIndex').listCategories(accId, 'store'))
      logDebug(ctx, 'tool_result', `🛒 ${list.length} producto(s) encontrados`, {})
      return 'Productos encontrados:\n' + list.slice(0, 8).map((p, i) => {
        const d = (p.shortDescription || p.description || '').slice(0, 200)
        return `${i + 1}. ${p.name} — ${p.price} ${p.currency}${p.stockStatus === 'outofstock' ? ' (agotado)' : ''}${d ? `\n   ${d}` : ''}`
      }).join('\n')
    }
    if (fnName === 'enviar_producto') {
      const list = await store.searchProductsSmart(accId, args?.producto || args?.consulta || '')
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
      if (cfg?.ordersEnabled === false) return 'La creación de pedidos está desactivada: un asesor humano gestionará el pedido. Ayuda al cliente con información de productos y avísale que un asesor tomará su pedido.'
      // El índice solo RESUELVE los productos; el pedido se crea contra la API viva
      // (la tienda calcula el precio real al crear el pedido).
      const pedidas = normalizeOrderItems(args)
      if (!pedidas.length) return 'No me indicaste qué productos lleva el pedido. Confirma con el cliente qué quiere y vuelve a llamar crear_pedido con todos los productos en "items".'
      const { lineas, faltantes } = await resolveOrderLines(pedidas, q => store.searchProductsSmart(accId, q))
      // Un pedido a medias que además se cobra es peor que ninguno: si algo no se
      // resuelve, no se crea nada y se le dice al modelo QUÉ falló para que pregunte.
      if (faltantes.length) {
        return `No encontré en la tienda: ${faltantes.map(f => `"${f}"`).join(', ')}. NO se creó ningún pedido. Confirma con el cliente el nombre exacto de ${faltantes.length > 1 ? 'esos productos' : 'ese producto'} (o búscalo con buscar_productos) y vuelve a llamar crear_pedido con TODOS los productos juntos.`
      }
      // Datos del cliente/envío CONFIGURABLES: se recogen de los argumentos de la IA y,
      // como respaldo, de variables/conversación para nombre/teléfono/email.
      const fields = ctx.account?.woocommerce?.orderForm || []
      const labels = store.ORDER_FIELD_LABELS
      const customer = {}
      for (const f of fields) { const v = String(args?.[f.key] ?? '').trim(); if (v) customer[f.key] = v }
      if (!customer.nombre) customer.nombre = ctx.variables?.user_name || ctx.variables?.var_nombre || ctx.variables?.nombre || ''
      if (!customer.email) customer.email = ctx.variables?.user_email || ctx.variables?.var_email || ctx.variables?.email || ''
      if (!customer.telefono) customer.telefono = ctx.variables?.telefono || ctx.variables?.var_telefono || ''
      if ((!customer.nombre || !customer.telefono) && ctx.convId) {
        try {
          const [[c]] = await require('../../db').query('SELECT guest_name, wa_from FROM conversations WHERE id=? AND account_id=?', [ctx.convId, accId])
          if (c) {
            if (!customer.nombre && c.guest_name && !/^(Visitante|Guest|WA #|FB #|IG #)/i.test(c.guest_name)) customer.nombre = c.guest_name
            if (!customer.telefono && c.wa_from) customer.telefono = c.wa_from
          }
        } catch { /* no bloquea */ }
      }
      // Valida los OBLIGATORIOS configurados: si falta alguno, pídeselo (no crea el pedido).
      const missing = fields.filter(f => f.required && labels[f.key] && !String(customer[f.key] || '').trim()).map(f => labels[f.key])
      if (missing.length) return `Antes de crear el pedido necesito estos datos del cliente para el envío/facturación: ${missing.join(', ')}. Pídeselos al cliente y vuelve a llamar crear_pedido con esos datos.`
      const order = await store.createOrder(accId, {
        items: lineas.map(l => ({ productId: l.product.id, variantId: l.product.variantId, quantity: l.cantidad })),
        customer, convId: ctx.convId, agId: ctx.agId,
      })
      // Mensaje del evento "pedido creado" según la config (default/IA/flujo/off).
      const resumen = lineas.map(l => `${l.cantidad} × ${l.product.name}`).join(', ')
      const vars = { pay_url: order.payUrl, total: order.total, currency: order.currency, pedido_id: order.orderId, pedido_items: resumen, pedido_estado: order.status || 'pending' }
      await require('../../services/orderNotify').emit(accId, ctx.agId, ctx.convId, 'created', vars, ctx)
      logDebug(ctx, 'tool_result', `🛒 Pedido #${order.orderId} creado · ${lineas.length} línea(s) · ${order.total} ${order.currency}`, { items: resumen })
      return `Pedido #${order.orderId} creado con ${lineas.length} producto(s) (${resumen}) por ${order.total} ${order.currency}. Link de pago ÚNICO para todo el pedido: ${order.payUrl}. No crees otro pedido.`
    }
    if (fnName === 'ver_pedido') {
      let orderId = String(args?.numero_pedido || '').replace(/[^\d]/g, '')
      if (!orderId && ctx.convId) {
        try { const [[r]] = await require('../../db').query('SELECT order_id FROM woo_orders WHERE account_id=? AND conv_id=? ORDER BY created_at DESC LIMIT 1', [accId, ctx.convId]); orderId = r?.order_id || '' } catch {}
      }
      if (!orderId) return 'Pídele al cliente el número de su pedido para consultarlo.'
      const o = await store.getOrder(accId, orderId)
      if (!o) return `No encontré el pedido #${orderId} en la tienda. Verifica el número con el cliente.`
      const es = require('../../services/orderNotify').statusEs(o.status)
      logDebug(ctx, 'tool_result', `🛒 Pedido #${o.id}: ${o.status}`, {})
      return `Pedido #${o.id}: estado "${es}"${o.total ? ` · total ${o.total} ${o.currency}` : ''}. Infórmale al cliente en lenguaje natural.`
    }
  } catch (e) {
    logDebug(ctx, 'error', `Tienda (${fnName}): ${e.message}`, {})
    // Devuelve el MOTIVO real para que el modelo se lo diga al cliente (email requerido,
    // producto sin stock, variante, etc.) en vez de un genérico "no se pudo".
    if (fnName === 'crear_pedido') return `No se pudo crear el pedido. Motivo exacto de la tienda: "${e.message}". Dile al cliente ese motivo tal cual; si falta un dato (p. ej. su email), pídeselo y reintenta.`
    return `No se pudo completar la acción de la tienda: ${e.message}`
  }
  return 'Acción de tienda no reconocida.'
}

// ── Catálogo de Meta: herramienta especial (responder / enviar / pedidos) ──────
const CATALOG_FUNCS = new Set(['buscar_en_catalogo', 'enviar_producto_catalogo', 'enviar_catalogo', 'crear_pedido_catalogo'])
function buildCatalogToolDefs() {
  return [
    { type: 'function', function: { name: 'buscar_en_catalogo',
      description: 'Consulta el catálogo REAL conectado. Es tu ÚNICA fuente sobre qué se vende: tú no sabes qué hay.\n'
        + 'ÚSALA SIEMPRE ANTES DE RESPONDER cuando el cliente:\n'
        + '· pregunte por un producto, su precio o su disponibilidad;\n'
        + '· exprese una NECESIDAD, un problema, un gusto o una situación, aunque no nombre ningún producto. Ejemplos: "tengo calor" → busca "ventilador aire acondicionado refrescante"; "no duermo bien" → busca "almohada colchón descanso"; "busco un regalo" → busca "regalo".\n'
        + 'NUNCA recomiendes ni menciones un producto que no haya salido de esta búsqueda: no puedes saber si existe. Si dudas, busca.',
      parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'Palabras clave de lo que necesita el cliente. Si expresó una necesidad y no un producto, traduce la necesidad a los productos que podrían resolverla.' } }, required: ['consulta'] } } },
    { type: 'function', function: { name: 'enviar_producto_catalogo',
      description: 'Envía al usuario un producto del catálogo con su FOTO y ficha (nombre, precio, link). Úsalo cuando el usuario quiera VER un producto o pida su foto.',
      parameters: { type: 'object', properties: { producto: { type: 'string', description: 'Nombre o palabras clave del producto a enviar' } }, required: ['producto'] } } },
    { type: 'function', function: { name: 'enviar_catalogo',
      description: 'Envía al usuario el catálogo completo (lista de productos con precios). Úsalo cuando el usuario pida ver todo el catálogo o "qué productos tienen".',
      parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'crear_pedido_catalogo',
      description: 'Genera UN pedido a partir de productos del catálogo y envía UN ÚNICO link de pago (o lo registra para que un asesor lo confirme, si no hay pasarela). Úsalo SOLO cuando el usuario confirme que quiere comprar. Si pide VARIOS productos, van TODOS en "items" en UNA SOLA llamada: llamar varias veces generaría varios pedidos y varios links de pago.',
      parameters: { type: 'object', properties: {
        items: {
          type: 'array',
          description: 'TODOS los productos del pedido, en una sola llamada.',
          items: { type: 'object', properties: {
            producto: { type: 'string', description: 'Nombre del producto en el catálogo' },
            cantidad: { type: 'integer', description: 'Unidades (por defecto 1)' },
          }, required: ['producto'] },
        },
        producto: { type: 'string', description: 'OBSOLETO: usa "items".' },
        cantidad: { type: 'string', description: 'OBSOLETO: cantidad del campo "producto".' },
      }, required: ['items'] } } },
  ]
}
async function catalogExec(ctx, fnName, args) {
  const catalog = require('../../services/metaCatalog')
  const accId = ctx.accId
  try {
    if (fnName === 'buscar_en_catalogo') {
      const list = await require("../../services/productIndex").searchSmartMeta(accId, args?.consulta || args?.query || '')
      if (!list.length) return await emptySearchHint(accId, args?.consulta || args?.query || '', () => require('../../services/productIndex').listCategories(accId, 'meta'))
      logDebug(ctx, 'tool_result', `🛍 ${list.length} producto(s) en catálogo`, {})
      return 'Productos encontrados:\n' + list.slice(0, 8).map((p, i) => {
        const d = (p.description || '').slice(0, 160)
        const out = p.availability && !/in stock|available/i.test(p.availability) ? ' (no disponible)' : ''
        return `${i + 1}. ${p.name} — ${p.price || ''}${out}${d ? `\n   ${d}` : ''}`
      }).join('\n')
    }
    if (fnName === 'enviar_producto_catalogo') {
      const list = await require("../../services/productIndex").searchSmartMeta(accId, args?.producto || args?.consulta || '')
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
      const pedidas = normalizeOrderItems(args)
      if (!pedidas.length) return 'No me indicaste qué productos lleva el pedido. Confirma con el cliente y vuelve a llamar con todos los productos en "items".'
      const idx = require('../../services/productIndex')
      const { lineas, faltantes } = await resolveOrderLines(pedidas, q => idx.searchSmartMeta(accId, q))
      // Igual que en la tienda: nada de pedidos a medias. Si falta un producto, no se
      // cobra por los demás sin que el cliente lo sepa.
      if (faltantes.length) {
        return `No encontré en el catálogo: ${faltantes.map(f => `"${f}"`).join(', ')}. NO se creó ningún pedido. Confirma con el cliente el nombre exacto y vuelve a llamar con TODOS los productos juntos.`
      }
      const precioDe = p => parseFloat(String(p.price || '').replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0
      const total = lineas.reduce((suma, l) => suma + precioDe(l.product) * l.cantidad, 0)
      const detalle = lineas.map(l => `${l.cantidad} × ${l.product.name}`).join('\n')
      const resumen = lineas.map(l => `${l.cantidad} × ${l.product.name}`).join(', ')
      if (ctx.account?.payments?.connected && total > 0) {
        const payments = require('../../services/payments')
        const r = await payments.createPaymentLink(accId, { amount: total, description: resumen.slice(0, 200), convId: ctx.convId, agId: ctx.agId })
        await sendBotMsg(ctx, `🛒 Pedido:\n${detalle}\nTotal: ${r.amount} ${r.currency}\n\n💳 Paga aquí:\n${r.url}\n\nApenas completes el pago te confirmo automáticamente.`)
        logDebug(ctx, 'tool_result', `🛒 Pedido catálogo · ${lineas.length} línea(s) · ${r.amount} ${r.currency}`, { items: resumen })
        return `Pedido creado con ${lineas.length} producto(s) (${resumen}) por ${r.amount} ${r.currency} y envié UN link de pago para todo. No crees otro pedido.`
      }
      await sendBotMsg(ctx, `🛒 Pedido registrado:\n${detalle}${total ? `\nTotal estimado: ${total} ${lineas[0].product.currency || ''}` : ''}\n\nUn asesor confirmará tu pedido en breve.`)
      logDebug(ctx, 'tool_result', `🛒 Pedido catálogo registrado · ${lineas.length} línea(s)`, { items: resumen })
      return `Pedido de ${resumen} registrado (sin pasarela de pago conectada; lo confirmará un asesor). No crees otro pedido.`
    }
  } catch (e) {
    logDebug(ctx, 'error', `Catálogo: ${e.message}`, {})
    return `No se pudo completar la acción del catálogo: ${e.message}`
  }
  return 'Acción de catálogo no reconocida.'
}

// ── Agenda de citas: herramienta especial con varias funciones ─────────────────
const AGENDA_FUNCS = new Set(['ver_disponibilidad', 'recomendar_citas', 'agendar_cita', 'mover_cita', 'cancelar_cita', 'confirmar_cita', 'ver_mis_citas'])
function buildAgendaToolDefs(account) {
  const cals = account?.scheduling?.calendars || []
  if (!cals.length) return []
  const menu = cals.map(c => `• ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n')
  const multi = cals.length > 1
  const servicioDesc = multi
    ? `Calendario/servicio a usar. ELIGE según la DESCRIPCIÓN del que mejor encaje con lo que pide el cliente (pasa el nombre del calendario). Calendarios disponibles:\n${menu}`
    : `(opcional; solo hay un calendario: ${cals[0].name})`
  // Campos "guardar en variable" configurados en los calendarios: cada uno tiene una
  // etiqueta de texto libre que la IA lee para saber qué dato obtener de la conversación.
  // Se agregan como parámetros OPCIONALES de agendar_cita (dedup por nombre); al agendar,
  // scheduling.js guarda cada valor en su variable.
  const { bookingVarParam } = require('../../services/bookings')
  const collectProps = {}
  const collectLabels = []
  for (const c of cals) {
    for (const bv of (c.bookingVars || [])) {
      if (!bv?.label || !bv?.variable) continue
      const p = bookingVarParam(bv.label)
      if (!collectProps[p]) { collectProps[p] = { type: 'string', description: `Dato a capturar de la conversación: ${bv.label}. Rellénalo si el cliente lo dio (no inventes).` }; collectLabels.push(bv.label) }
    }
  }
  // Instrucción explícita para que el modelo NO olvide pasar estos datos al agendar.
  const collectNote = collectLabels.length
    ? ` IMPORTANTE: este calendario REQUIERE recolectar estos datos para poder agendar: ${[...new Set(collectLabels)].join('; ')}. Antes de llamar a agendar_cita, PÍDESELOS al cliente y pásalos como argumentos. Si aún falta alguno, NO agendes: pídelo primero (el sistema rechazará la reserva si faltan).`
    : ''
  const agendarDesc = 'Agenda una cita. Úsalo SOLO cuando el cliente confirme fecha y hora (de las que diste por disponibilidad), tengas su nombre y hayas recolectado todos los datos requeridos.' + collectNote
  return [
    { type: 'function', function: { name: 'ver_disponibilidad', description: 'Muestra los horarios LIBRES de un calendario para una fecha. Úsalo cuando el cliente pregunte por disponibilidad de un día concreto. No inventes horarios.', parameters: { type: 'object', properties: { fecha: { type: 'string', description: 'Fecha TAL CUAL la dijo el cliente ("lunes", "el 15", "15 de julio", "mañana") o YYYY-MM-DD. NO calcules tú la fecha: pásala literal, el sistema la resuelve.' }, servicio: { type: 'string', description: servicioDesc } }, required: ['fecha'] } } },
    { type: 'function', function: { name: 'recomendar_citas', description: 'Recomienda las PRÓXIMAS citas disponibles (siguientes días con cupo). Úsalo cuando el cliente quiere agendar pero no fijó un día.', parameters: { type: 'object', properties: { servicio: { type: 'string', description: servicioDesc } } } } },
    { type: 'function', function: { name: 'agendar_cita', description: agendarDesc, parameters: { type: 'object', properties: { fecha: { type: 'string', description: 'Fecha tal cual la dijo el cliente ("lunes", "15 de julio") o YYYY-MM-DD; NO la calcules tú.' }, hora: { type: 'string', description: 'HH:MM' }, servicio: { type: 'string', description: servicioDesc }, nombre: { type: 'string', description: 'Nombre del cliente' }, telefono: { type: 'string' }, email: { type: 'string' }, nota: { type: 'string' }, ...collectProps }, required: ['fecha', 'hora'] } } },
    { type: 'function', function: { name: 'mover_cita', description: 'Reagenda la cita del cliente a otra fecha/hora.', parameters: { type: 'object', properties: { nueva_fecha: { type: 'string', description: 'Fecha tal cual la dijo el cliente ("lunes", "15 de julio") o YYYY-MM-DD; NO la calcules tú.' }, nueva_hora: { type: 'string', description: 'HH:MM' }, telefono: { type: 'string' }, bookingId: { type: 'string', description: 'id de la cita si el cliente tiene varias' } }, required: ['nueva_fecha', 'nueva_hora'] } } },
    { type: 'function', function: { name: 'cancelar_cita', description: 'Cancela la cita del cliente.', parameters: { type: 'object', properties: { telefono: { type: 'string' }, bookingId: { type: 'string', description: 'id de la cita si tiene varias' } } } } },
    { type: 'function', function: { name: 'confirmar_cita', description: 'Marca como CONFIRMADA la asistencia del cliente a su próxima cita. Úsalo cuando el cliente confirme que sí asistirá (responde "sí", "confirmo", "ahí estaré", "asistiré", etc.), típicamente tras un recordatorio.', parameters: { type: 'object', properties: { telefono: { type: 'string' }, bookingId: { type: 'string', description: 'id de la cita si el cliente tiene varias' } } } } },
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

// ── Tablas internas del cliente: consultar/agregar/editar/eliminar filas ───────
const DATATABLE_FUNCS = new Set(['consultar_tabla', 'agregar_fila', 'editar_fila', 'eliminar_fila'])
function buildDataTableToolDefs(account) {
  const tables = account?.dataTables?.tables || []
  if (!tables.length) return []
  const list = tables.map(t => `"${t.name}"${t.description ? ` (${t.description})` : ''}: columnas ${(t.columns || []).map(c => `${c.label}[${c.type}]`).join(', ')}`).join(' | ')
  const tablaDesc = `Nombre de la tabla. Disponibles → ${list}`
  return [
    { type: 'function', function: { name: 'consultar_tabla', description: `Consulta/lee filas de una tabla interna del negocio. Tablas: ${list}`, parameters: { type: 'object', properties: {
      tabla: { type: 'string', description: tablaDesc },
      filtros: { type: 'object', description: 'Filtro por columnas (igualdad), ej. {"Producto":"Camisa"}. Opcional.' },
      texto: { type: 'string', description: 'Búsqueda libre en cualquier columna. Opcional.' },
      limite: { type: 'number', description: 'Máx. filas a devolver (por defecto 20).' },
    }, required: ['tabla'] } } },
    { type: 'function', function: { name: 'agregar_fila', description: 'Agrega una fila nueva a una tabla interna.', parameters: { type: 'object', properties: {
      tabla: { type: 'string', description: tablaDesc },
      valores: { type: 'object', description: 'Objeto columna→valor con los datos de la fila nueva.' },
    }, required: ['tabla', 'valores'] } } },
    { type: 'function', function: { name: 'editar_fila', description: 'Edita la primera fila que coincide con "buscar".', parameters: { type: 'object', properties: {
      tabla: { type: 'string', description: tablaDesc },
      buscar: { type: 'object', description: 'Cómo localizar la fila (igualdad por columna), ej. {"Producto":"Camisa"}.' },
      valores: { type: 'object', description: 'Columnas a cambiar con sus nuevos valores.' },
    }, required: ['tabla', 'buscar', 'valores'] } } },
    { type: 'function', function: { name: 'eliminar_fila', description: 'Elimina las filas que coinciden con "buscar".', parameters: { type: 'object', properties: {
      tabla: { type: 'string', description: tablaDesc },
      buscar: { type: 'object', description: 'Cómo localizar la(s) fila(s) a eliminar.' },
    }, required: ['tabla', 'buscar'] } } },
  ]
}
// ── Recontacto: respetar la voluntad del cliente ──────────────────────────────
const RECONTACT_FUNCS = new Set(['marcar_no_recontactable', 'reactivar_recontacto'])
function buildRecontactToolDefs() {
  return [
    { type: 'function', function: {
      name: 'marcar_no_recontactable',
      description: 'Marca esta conversación para que NO se le envíen más recontactos automáticos. Úsala cuando el cliente pida explícitamente que no le escriban o no le insistan más.',
      parameters: { type: 'object', properties: {
        motivo: { type: 'string', description: 'Motivo breve en palabras del cliente. Opcional.' },
      }, required: [] },
    } },
    { type: 'function', function: {
      name: 'reactivar_recontacto',
      description: 'Vuelve a permitir los recontactos automáticos en esta conversación. Úsala si el cliente se retracta y pide que sí le escriban.',
      parameters: { type: 'object', properties: {}, required: [] },
    } },
  ]
}
async function recontactExec(ctx, fnName, args) {
  try {
    const stop = fnName === 'marcar_no_recontactable'
    // Se escribe UNA sola clave (setLocalVar), no el objeto entero: updateConvo({localVars})
    // sustituiría todas las variables de la conversación.
    // Reactivar guarda cadena vacía a propósito: el worker comprueba truthy, así que '0' NO reactivaría.
    await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, '_recontact_stopped', stop ? '1' : '')
    // Al reactivar hay que levantar TAMBIÉN el cierre del caso. El worker se salta la
    // conversación si ve CUALQUIERA de las dos banderas, y cerrar el caso pone las dos
    // (flow/nodes/human.js). Limpiando solo una, la IA respondía "los recontactos vuelven a
    // estar activos" y el worker seguía ignorando la conversación: el fallo reportado.
    if (!stop) await store.setLocalVar(ctx.accId, ctx.agId, ctx.convId, '_case_status', '')
    logDebug(ctx, 'flow_run', stop ? '🛑 Marcado como NO recontactable' : '🔁 Recontactos reactivados',
      { motivo: args?.motivo || undefined })
    return stop
      ? 'Listo: no se le enviarán más recontactos automáticos.'
      : 'Listo: los recontactos automáticos vuelven a estar activos.'
  } catch (e) { return `No se pudo cambiar el estado de recontacto: ${e.message}` }
}

// ── Etiquetas del CRM ─────────────────────────────────────────────────────────
// El modelo solo ve las etiquetas MARCADAS como disponibles para la IA (account.aiLabels)
// y trabaja con sus nombres; la descripción de cada una le dice cuándo aplicarla.
const LABEL_FUNCS = new Set(['aplicar_etiqueta', 'quitar_etiqueta'])
function buildLabelToolDefs(account) {
  const labels = account?.aiLabels || []
  if (!labels.length) return []
  const menu = labels.map(l => `- "${l.name}"${l.description ? `: ${l.description}` : ''}`).join('\n')
  const etiquetaDesc = `Nombre exacto de la etiqueta. Disponibles:\n${menu}`
  return [
    { type: 'function', function: {
      name: 'aplicar_etiqueta',
      description: `Etiqueta esta conversación para clasificar al cliente. Aplica una etiqueta solo cuando su descripción encaje de verdad con lo que dice el cliente.\nEtiquetar es INDEPENDIENTE de mover el ticket: si el cliente avanzó de etapa Y además encaja una etiqueta, haz las DOS cosas en este turno.\nEtiquetas disponibles:\n${menu}`,
      parameters: { type: 'object', properties: { etiqueta: { type: 'string', description: etiquetaDesc } }, required: ['etiqueta'] },
    } },
    { type: 'function', function: {
      name: 'quitar_etiqueta',
      description: 'Retira una etiqueta que ya no corresponde a esta conversación (p. ej. el cliente dejó de estar interesado).',
      parameters: { type: 'object', properties: { etiqueta: { type: 'string', description: etiquetaDesc } }, required: ['etiqueta'] },
    } },
  ]
}
async function labelExec(ctx, fnName, args) {
  try {
    const labels = ctx.account?.aiLabels || []
    const wanted = String(args?.etiqueta || '').trim().toLowerCase()
    const found = labels.find(l => l.name.toLowerCase() === wanted)
    if (!found) return `La etiqueta "${args?.etiqueta || ''}" no existe o no está disponible. Disponibles: ${labels.map(l => l.name).join(', ') || 'ninguna'}.`

    const [[conv]] = await require('../../db').query('SELECT labels FROM conversations WHERE id=? AND account_id=?', [ctx.convId, ctx.accId])
    if (!conv) return 'No se encontró la conversación.'
    const current = require('../../utils').parseJ(conv.labels, [])
    const add = fnName === 'aplicar_etiqueta'
    const next = add
      ? [...new Set([...current, found.id])]
      : current.filter(id => id !== found.id)
    if (next.length === current.length) {
      return add ? `La conversación ya tenía la etiqueta "${found.name}".` : `La conversación no tenía la etiqueta "${found.name}".`
    }
    await store.updateConvo(ctx.accId, ctx.agId, ctx.convId, { labels: next })
    logDebug(ctx, 'flow_run', `${add ? '🏷 Etiqueta aplicada' : '🏷 Etiqueta retirada'}: ${found.name}`, {})
    return add ? `Etiqueta "${found.name}" aplicada.` : `Etiqueta "${found.name}" retirada.`
  } catch (e) { return `No se pudo cambiar la etiqueta: ${e.message}` }
}

// ── Ticket del pipeline de ESTA conversación ──────────────────────────────────
// Solo pipelines marcados para la IA. `applyTicketAction` actúa exclusivamente sobre la
// tarjeta vinculada a esta conversación: nunca toca las de otros chats.
const PIPELINE_FUNCS = new Set(['crear_ticket', 'mover_ticket'])
function buildPipelineToolDefs(account) {
  const pipes = account?.aiPipelines || []
  if (!pipes.length) return []
  // El menú incluye la DESCRIPCIÓN de cada etapa cuando la hay. Con solo los nombres, ante
  // etapas como "En proceso" o "Seguimiento" el modelo no tiene forma de saber cuál toca, y
  // por eso ubicaba mal a los clientes. La descripción es lo que convierte la lista en un
  // criterio. Las etapas apagadas para la IA ya vienen filtradas de la cuenta.
  const menu = pipes.map(p => {
    const stages = p.stages || []
    if (!stages.length) return `- Pipeline "${p.name}" → (sin etapas disponibles)`
    const conDesc = stages.some(s => s.description)
    if (!conDesc) return `- Pipeline "${p.name}" → etapas: ${stages.map(s => `"${s.name}"`).join(', ')}`
    return `- Pipeline "${p.name}" → etapas:\n`
      + stages.map(s => `    · "${s.name}"${s.description ? `: ${s.description}` : ''}`).join('\n')
  }).join('\n')
  const multi = pipes.length > 1
  const pipeDesc = multi
    ? `Nombre del pipeline. Disponibles:\n${menu}`
    : `(opcional; solo hay un pipeline: "${pipes[0].name}")`
  const etapaDesc = `Nombre exacto de la etapa destino. Opciones:\n${menu}`
  return [
    { type: 'function', function: {
      name: 'mover_ticket',
      // Mover el ticket y etiquetar son acciones INDEPENDIENTES, y hay que decirlo: si no,
      // el modelo trata "mover el ticket" como LA acción del turno y se deja la etiqueta sin
      // poner, que es el fallo de "a veces etiqueta y a veces no" cuando toca hacer ambas.
      description: `Mueve el ticket de ESTA conversación a otra etapa del pipeline, cuando la conversación muestre que el cliente avanzó. Si aún no tiene ticket, se crea en esa etapa.\nMover el ticket NO etiqueta la conversación: son acciones distintas. Si además corresponde una etiqueta, llama TAMBIÉN a la herramienta de etiquetas en este mismo turno.\n${menu}`,
      parameters: { type: 'object', properties: {
        etapa: { type: 'string', description: etapaDesc },
        pipeline: { type: 'string', description: pipeDesc },
      }, required: ['etapa'] },
    } },
    { type: 'function', function: {
      name: 'crear_ticket',
      description: `Crea el ticket de ESTA conversación en un pipeline. Úsalo cuando aparezca una oportunidad de negocio que aún no está registrada.\nCrear el ticket NO etiqueta la conversación: son acciones distintas. Si además corresponde una etiqueta, llama TAMBIÉN a la herramienta de etiquetas en este mismo turno.\n${menu}`,
      parameters: { type: 'object', properties: {
        etapa: { type: 'string', description: etapaDesc },
        pipeline: { type: 'string', description: pipeDesc },
        titulo: { type: 'string', description: 'Título breve del negocio. Opcional (por defecto, el nombre del cliente).' },
        valor: { type: 'string', description: 'Valor estimado del negocio, si el cliente lo dijo. Opcional.' },
      }, required: [] },
    } },
  ]
}
// Resuelve pipeline + etapa por NOMBRE contra los pipelines marcados. Compartido con el
// proxy público del navegador, por eso vive suelto.
function resolvePipelineTarget(pipes, pipelineName, stageName) {
  const list = pipes || []
  if (!list.length) return { error: 'No hay pipelines disponibles para el asistente.' }
  const pn = String(pipelineName || '').trim().toLowerCase()
  const pipe = pn
    ? list.find(p => p.name.toLowerCase() === pn) || list.find(p => p.name.toLowerCase().includes(pn))
    : list[0]
  if (!pipe) return { error: `El pipeline "${pipelineName}" no existe o no está disponible. Disponibles: ${list.map(p => p.name).join(', ')}.` }
  const sn = String(stageName || '').trim().toLowerCase()
  const stage = sn
    ? (pipe.stages || []).find(s => s.name.toLowerCase() === sn) || (pipe.stages || []).find(s => s.name.toLowerCase().includes(sn))
    : (pipe.stages || [])[0]
  if (sn && !stage) return { error: `La etapa "${stageName}" no existe en "${pipe.name}". Etapas: ${(pipe.stages || []).map(s => s.name).join(', ')}.` }
  return { pipe, stage }
}
async function pipelineExec(ctx, fnName, args) {
  try {
    const r = resolvePipelineTarget(ctx.account?.aiPipelines, args?.pipeline, args?.etapa)
    if (r.error) return r.error
    const out = await require('../../services/tickets').applyTicketAction(ctx.accId, ctx.convId, {
      tipo: 'deal',
      accion: fnName === 'crear_ticket' ? 'crear' : 'mover',
      pipelineId: r.pipe.id,
      stageId: r.stage?.id || null,
      title: args?.titulo || '',
      value: args?.valor || '',
    })
    ctx.variables._ticket_action = out
    logDebug(ctx, 'flow_run', `🎫 Ticket ${fnName === 'crear_ticket' ? 'creado' : 'movido'} en "${r.pipe.name}"${r.stage ? ` → ${r.stage.name}` : ''}`, {})
    return fnName === 'crear_ticket'
      ? `Ticket creado en "${r.pipe.name}"${r.stage ? `, etapa "${r.stage.name}"` : ''}.`
      : `Ticket movido a "${r.stage?.name || '?'}" en "${r.pipe.name}".`
  } catch (e) { return `No se pudo gestionar el ticket: ${e.message}` }
}

// ── Datos del cliente en variables ────────────────────────────────────────────
// Solo las variables MARCADAS para la IA. Una sola llamada puede guardar varios datos.
const VARIABLE_FUNCS = new Set(['guardar_datos'])
function aiVariables(account) {
  return (account?.variables || []).filter(v => v.aiEnabled !== false && !v.isSystem)
}
function buildVariableToolDefs(account) {
  const vars = aiVariables(account)
  if (!vars.length) return []
  const menu = vars.map(v => `- "${v.name}"${v.description ? `: ${v.description}` : ''}`).join('\n')
  return [
    { type: 'function', function: {
      name: 'guardar_datos',
      description: `Guarda datos que el cliente haya dicho en esta conversación. Usa SOLO los nombres de esta lista y NO inventes valores: si el cliente no lo dijo, no lo incluyas.\nDatos que puedes guardar:\n${menu}`,
      parameters: { type: 'object', properties: {
        datos: { type: 'object', description: 'Objeto nombre_del_dato → valor. Ej: {"ciudad":"Bogotá","presupuesto":"2 millones"}' },
      }, required: ['datos'] },
    } },
  ]
}
async function variableExec(ctx, args) {
  try {
    const vars = aiVariables(ctx.account)
    const datos = (args && typeof args.datos === 'object' && args.datos) || {}
    const saved = [], unknown = []
    for (const [name, value] of Object.entries(datos)) {
      if (value == null || String(value).trim() === '') continue
      const def = vars.find(v => v.name.toLowerCase() === String(name).trim().toLowerCase())
      if (!def) { unknown.push(name); continue }
      await setVarBoth(ctx, def.id, String(value).slice(0, 500))
      saved.push(def.name)
    }
    if (!saved.length && !unknown.length) return 'No había datos que guardar.'
    logDebug(ctx, 'flow_run', `💾 Datos guardados: ${saved.join(', ') || 'ninguno'}`, { noReconocidos: unknown })
    let msg = saved.length ? `Datos guardados: ${saved.join(', ')}.` : 'No se guardó ningún dato.'
    if (unknown.length) msg += ` No existen (o no están disponibles): ${unknown.join(', ')}.`
    return msg
  } catch (e) { return `No se pudieron guardar los datos: ${e.message}` }
}

// ── Tareas del CRM ────────────────────────────────────────────────────────────
// El asistente agenda seguimientos para el cliente de ESTA conversación. La lógica de
// asignación y de fecha vive en services/aiTasks para compartirla con el webchat.
const TASK_FUNCS = new Set(['crear_tarea'])
function buildTaskToolDefs(account) {
  const advisors = (account?.members || []).map(m => m.name).filter(Boolean)
  return [
    { type: 'function', function: {
      name: 'crear_tarea',
      description: 'Crea una tarea de seguimiento en el CRM para este cliente (llamarlo, enviarle algo, recordar una gestión). Úsala cuando quede algo pendiente por hacer. Si indicas fecha y hora, el asesor recibe un recordatorio antes del vencimiento. NO la uses para agendar citas con el cliente: para eso está la agenda.',
      parameters: { type: 'object', properties: {
        titulo: { type: 'string', description: 'Qué hay que hacer, en pocas palabras. Ej: "Llamar a Ana para confirmar la cotización".' },
        descripcion: { type: 'string', description: 'Detalle o contexto útil para quien la ejecute. Opcional.' },
        fecha: { type: 'string', description: 'Fecha de vencimiento en formato AAAA-MM-DD. Calcúlala a partir de la fecha actual que tienes arriba (p. ej. "mañana"). Opcional: sin fecha no hay recordatorio.' },
        hora: { type: 'string', description: 'Hora de vencimiento en formato HH:MM (24 h). Opcional; por defecto 09:00.' },
        tipo: { type: 'string', enum: ['general', 'llamada', 'whatsapp', 'correo', 'reunion', 'seguimiento'], description: 'Tipo de gestión. Opcional.' },
        prioridad: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Prioridad. Opcional (normal por defecto).' },
        asignar_a: advisors.length
          ? { type: 'string', description: `Nombre del asesor responsable. Por defecto se asigna al asesor de este chat; indícalo solo si debe ser otro. Asesores: ${advisors.join(', ')}.` }
          : { type: 'string', description: 'Nombre del asesor responsable. Opcional.' },
      }, required: ['titulo'] },
    } },
  ]
}
async function taskExec(ctx, args) {
  try {
    const out = await require('../../services/aiTasks').createAiTask(ctx.accId, ctx.convId, args || {}, {
      timezone: ctx.account?.aiTimezone || ctx.account?.scheduling?.timezone || 'America/Bogota',
    })
    if (out.ok) logDebug(ctx, 'flow_run', `✅ Tarea creada: ${args?.titulo || ''}`, { asignada: out.assigneeName || '(sin asignar)', vence: out.dueAt || null })
    return out.text
  } catch (e) { return `No se pudo crear la tarea: ${e.message}` }
}

async function dataTableExec(ctx, fnName, args) {
  try {
    const dt = require('../../services/dataTables')
    const r = await dt.toolCall(ctx.accId, fnName, args || {})
    logDebug(ctx, 'tool_result', `📊 ${fnName}`, {})
    return r?.text || 'Hecho.'
  } catch (e) { return `No se pudo completar la acción en la tabla: ${e.message}` }
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
      let amount = parseFloat(String(args?.monto || '').replace(/[^\d.]/g, ''))
      let note = ''
      // Si hay un carrito de pedidos ABIERTO, manda el total del carrito y no el que calculó
      // el modelo: el monto lo sumaba la IA de cabeza, así que un producto que no se agregó
      // —o una suma mal hecha— generaba un cobro por menos sin que nadie se enterara.
      try {
        const cart = await require('../../services/orders').cartTotalFor(accId, ctx.convId)
        if (cart && cart.items > 0 && cart.total > 0) {
          if (Math.round(cart.total) !== Math.round(amount || 0)) {
            note = ` (se usó el total real del pedido, ${cart.items} producto(s); el monto indicado no coincidía)`
            logDebug(ctx, 'flow_run', `💳 Monto corregido con el carrito: ${amount || 0} → ${cart.total}`, { items: cart.items })
          }
          amount = cart.total
        }
      } catch { /* sin módulo de pedidos: se cobra el monto indicado, como siempre */ }

      if (!amount || amount <= 0) return 'Indica un monto válido para generar el link de pago.'
      const r = await payments.createPaymentLink(accId, {
        amount, description: args?.concepto || 'Pago', convId: ctx.convId, agId: ctx.agId,
      })
      await sendBotMsg(ctx, `💳 Aquí está tu link de pago por ${r.amount} ${r.currency}:\n${r.url}\n\nApenas completes el pago te confirmo automáticamente.`)
      logDebug(ctx, 'tool_result', `💳 Link de pago ${r.amount} ${r.currency}`, {})
      return `Link de pago generado por ${r.amount} ${r.currency} y enviado al usuario${note}.`
    }
    if (fnName === 'verificar_pago') {
      // Consulta el estado EN VIVO del proveedor (no depende del webhook). Si el pago se
      // acaba de resolver, dispara los efectos (pedido/reserva/flujo) una sola vez; el
      // mensaje al cliente lo da el propio asistente (sendChat:false para no duplicar).
      const st = await payments.reconcileLatestIntent(accId, ctx.convId)
      if (!st) return 'No hay ningún pago pendiente en esta conversación.'
      logDebug(ctx, 'tool_result', `💳 Estado pago: ${st.status}${st.justResolved ? ' (recién confirmado)' : ''}`, {})
      if (st.justResolved) {
        try { await require('../../controllers/payments.controller').finalizePayment(accId, { status: st.status, intent: st, transactionId: st.transaction_id, flowId: st.flowId, matched: true }, { sendChat: false }) } catch (e) { logDebug(ctx, 'error', `Pago efectos: ${e.message}`, {}) }
      }
      if (st.status === 'approved') return `El pago de ${st.amount} ${st.currency} está CONFIRMADO.`
      if (st.status === 'declined') return `El pago de ${st.amount} ${st.currency} fue RECHAZADO o no se completó.`
      return `El pago de ${st.amount} ${st.currency} aún está PENDIENTE (sin confirmar todavía). Pídele al cliente que complete el pago en el link; si ya pagó, dile que espere unos segundos y vuelve a verificar.`
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
      description: `Lista las habitaciones/tipos${hotel} (nombre, capacidad y descripción) EN TEXTO. Es tu ÚNICA fuente sobre qué alojamientos existen: tú no los conoces. Úsalo cuando el cliente pregunte "qué habitaciones tienen" —y enuméraselas por su NOMBRE— y TAMBIÉN cuando describa lo que BUSCA sin nombrar ninguna ("algo para 4", "una con jacuzzi", "la más económica", "que tenga vista al mar"): pon esa descripción en "habitacion" y te devuelve la que encaja. NUNCA menciones una habitación que no haya salido de aquí. NO envía fotos por defecto. Envía FOTOS solo si el cliente las pide: "habitacion"=<nombre> para las fotos+ficha de una, o "fotos"=true para el panorama. Cada envío de fotos manda fotos NUEVAS; si el cliente pide "más fotos", vuelve a llamarlo; con desde_inicio=true reenvía desde el principio.`,
      parameters: { type: 'object', properties: {
        habitacion: { type: 'string', description: 'Nombre de una habitación concreta, O lo que el cliente busca descrito con sus palabras ("con jacuzzi", "para 4 personas"), para enviar sus FOTOS y ficha (vacío = solo lista/panorama)' },
        fotos: { type: 'boolean', description: 'true SOLO si el cliente pide ver fotos (envía el panorama). Por defecto (false) la función solo lista las habitaciones en texto.' },
        desde_inicio: { type: 'boolean', description: 'true para reenviar las fotos desde el principio (cuando el cliente ya vio todas y quiere verlas otra vez)' },
        ...propParam,
      } } } },
    { type: 'function', function: { name: 'ver_disponibilidad_hotel',
      description: 'Consulta la disponibilidad REAL del hotel para un rango de fechas con precios y cotización total. Úsalo antes de reservar. NUNCA inventes precios ni disponibilidad. Cada alojamiento tiene su propio cupo: si el cliente pregunta por un alojamiento concreto, pásalo en "habitacion" para responder SOLO por ese; si está lleno, se informa que no está disponible (NO ofrezcas otro como si fuera ese).',
      parameters: { type: 'object', properties: {
        checkin: { type: 'string', description: 'Fecha de entrada YYYY-MM-DD' },
        checkout: { type: 'string', description: 'Fecha de salida YYYY-MM-DD' },
        adultos: { type: 'number', description: 'Número de adultos (mínimo 1)' },
        ninos: { type: 'number', description: 'Número de niños (opcional)' },
        infantes: { type: 'number', description: 'Número de infantes (opcional)' },
        habitaciones: { type: 'number', description: 'Número de habitaciones (opcional)' },
        habitacion: { type: 'string', description: 'Nombre del alojamiento/habitación concreto por el que pregunta el cliente. Si se indica, la disponibilidad se limita a ESE alojamiento (opcional).' },
        codigo_promocional: { type: 'string', description: 'Código promocional si el cliente tiene uno (opcional)' },
        ...propParam,
      }, required: ['checkin', 'checkout', 'adultos'] } } },
    { type: 'function', function: { name: 'reservar_habitacion',
      description: 'Crea la RESERVA en el PMS del hotel. Úsalo SOLO cuando el cliente confirme fechas y opción, y tengas su nombre, email y teléfono. ANTES de reservar, PREGÚNTALE cómo desea pagar: "online" (pago en línea, se le envía un link) o "efectivo" (paga al llegar al hotel), y pásalo en "metodo_pago". Devuelve el código de reserva y, si es en línea, el link de pago.',
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
        metodo_pago: { type: 'string', description: 'Cómo paga el cliente: "online" (pago en línea con link) o "efectivo" (paga al llegar al hotel). Pregúntaselo antes de reservar.' },
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
      description: 'Registra una SOLICITUD de cambio de fechas de una reserva (el hotel la procesa MANUALMENTE; el PMS no reagenda por API). Pide el código y las nuevas fechas. NO le digas al cliente que ya quedó reagendada: es una solicitud pendiente de confirmación del hotel.',
      parameters: { type: 'object', properties: {
        codigo: { type: 'string', description: 'Código de la reserva (HR-…)' },
        nueva_checkin: { type: 'string', description: 'Nueva fecha de entrada YYYY-MM-DD' },
        nueva_checkout: { type: 'string', description: 'Nueva fecha de salida YYYY-MM-DD' },
        motivo: { type: 'string' },
      }, required: ['codigo', 'nueva_checkin', 'nueva_checkout'] } } },
    { type: 'function', function: { name: 'cancelar_reserva',
      description: 'Registra una SOLICITUD de cancelación de una reserva (el hotel la procesa MANUALMENTE; el PMS no cancela por API). Pide el código. NO le digas al cliente que ya quedó cancelada: es una solicitud pendiente de confirmación del hotel.',
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
      description: 'Agrega productos al pedido (carrito) del cliente. IMPORTANTE: si el cliente pide varias cosas de una vez, mándalas TODAS juntas en `productos` en UNA sola llamada — no hagas una llamada por producto.',
      parameters: { type: 'object', properties: {
        productos: {
          type: 'array',
          description: 'Lista completa de lo que pide el cliente. Úsala siempre que sean 2 o más productos.',
          items: { type: 'object', properties: {
            producto: { type: 'string', description: 'Nombre del producto tal como aparece en el menú' },
            cantidad: { type: 'number', description: 'Cantidad (mínimo 1)' },
            adiciones: { type: 'string', description: 'Adiciones/modificadores separados por coma (ej. "extra queso, sin cebolla")' },
            nota: { type: 'string', description: 'Nota para la cocina sobre este producto (opcional)' },
          }, required: ['producto'] },
        },
        producto: { type: 'string', description: 'Atajo para UN solo producto (equivale a productos con un elemento)' },
        cantidad: { type: 'number', description: 'Cantidad del producto único (mínimo 1)' },
        adiciones: { type: 'string', description: 'Adiciones del producto único' },
        nota: { type: 'string', description: 'Nota para la cocina del producto único' },
      } } } },
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

// Un mensaje que solo lleva ARCHIVO se guarda con content vacío (sendBotMsg persiste el
// caption, y al enviar varias fotos solo la primera lo tiene). Si se filtran por texto, el
// modelo no ve ni rastro de lo que envió: en el turno siguiente concluye —razonablemente—
// que aún no lo ha mandado y lo REENVÍA. Por eso se resumen a texto.
//
// Afecta a toda la media, no solo a "enviar_recurso": fotos de catálogo, comprobantes,
// adjuntos de calendario. Todos eran invisibles.
const MEDIA_LABEL = { image: 'imagen', video: 'vídeo', audio: 'audio', file: 'archivo' }
function historyText(m) {
  const text = typeof m.content === 'string' ? m.content.trim() : ''
  if (text) return text
  const kind = m.media?.kind || m.kind
  if (!kind && !m.mediaId && !m.mediaUrl) return ''       // sin texto ni archivo → nada que contar
  const label = MEDIA_LABEL[kind] || 'archivo'
  const name = m.filename || m.media?.filename || ''
  return `[enviado: ${label}${name ? ` — ${name}` : ''}]`
}

// Carga los turnos recientes para dar MEMORIA al agente. Descarta el/los turnos
// finales del usuario porque el nodo aporta su propio "mensaje actual".
async function loadHistory(ctx, limit = 16) {
  try {
    const convos = await store.readConvos(ctx.accId, ctx.agId)
    const conv = (convos || []).find(c => c.id === ctx.convId)
    const msgs = (conv?.messages || [])
      .map(m => ({
        role: (m.sender === 'user' || m.role === 'user') ? 'user' : 'assistant',
        content: historyText(m),
      }))
      .filter(m => m.content)
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

async function callAI(ctx, { systemPrompt, userPrompt, model, provider, maxTokens, temperature = 0.5, jsonMode = false, advanced = {}, history = [], tools = [], onToolCall, onTools, onResolved }) {
  // Fallback CENTRAL: cuando el nodo no fija modelo (Chat IA, Clasificador, Extractor,
  // Sentimiento, Router…), se usa el modelo/proveedor por defecto de la PLATAFORMA (lo
  // gobierna el super admin), NO 'gpt-4o-mini'. Así ningún nodo IA corre gpt-4o-mini por
  // sorpresa cuando la plataforma usa DeepSeek.
  const platModel = ctx?.account?.defaultPromptModel || ''
  const platProvider = ctx?.account?.defaultPromptProvider || ''
  const effModel = model || platModel
  const prov = provider || platProvider || detectProvider(effModel || 'gpt-4o-mini')
  const finalModel = effModel || DEFAULT_MODEL[prov] || 'gpt-4o-mini'
  const apiKey = getApiKey(ctx.account, prov)
  if (typeof onResolved === 'function') {
    onResolved({ provider: prov, model: finalModel, keySource: apiKey ? 'account' : 'none' })
  }
  if (!apiKey) throw new Error(`Sin API Key para ${prov}`)

  // Parámetros avanzados del prompt (max_tokens de salida, top_p, penalties, seed, stop,
  // reasoning_effort, thinking…) → se pasan al body. jsonMode añade el response_format.
  const advForBody = { ...advanced, ...(jsonMode ? { responseFormat: { type: 'json_object' } } : {}) }

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

  // Respuesta TRUNCADA por el techo de tokens: el proveedor devuelve finish_reason 'length'.
  // Antes se descartaba en silencio y el usuario veía la respuesta cortada a la mitad sin
  // ninguna pista. Ahora queda registrado en el log de la conversación con el límite aplicado.
  const onFinish = (f) => {
    if (f?.finishReason !== 'length') return
    try {
      logDebug(ctx, 'error',
        `⚠️ Respuesta truncada: se alcanzó el límite de ${f.maxTokens} tokens de salida. Súbelo en los ajustes avanzados del prompt.`,
        { maxTokens: f.maxTokens, provider: prov, model: finalModel })
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
    const tz = ctx.account?.aiTimezone || ctx.account?.scheduling?.timezone || 'America/Bogota'
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
  // (DeepSeek) y hace que la herramienta "se active solo una vez".
  if (tools.length > 0) {
    const convo = messages.slice()
    const executed = []
    // Mensajes ya enviados antes de ejecutar herramientas: si alguna herramienta responde
    // por su cuenta, no hace falta que el modelo redacte nada más (se descartaría).
    const sentAtStart = ctx._sentCount || 0
    // Headroom para varios triggers consecutivos (cada uno consume una ronda)
    // + la respuesta final del modelo.
    // 10 y no 6: una conversación de pedido gasta rondas en ver el menú, agregar, fijar la
    // entrega, aplicar cupón y confirmar. Con 6 se agotaban antes de terminar y el pedido
    // quedaba incompleto sin que nada diera error.
    const MAX_ROUNDS = 10

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
      // Excepción: si la herramienta YA envió un mensaje al usuario (p. ej. la
      // transferencia a asesor), redactar sería una llamada inútil que además
      // acabaría descartada por no duplicar la respuesta.
      const toolAlreadySpoke = (ctx._sentCount || 0) > sentAtStart
      if (!clean && executed.length && !toolAlreadySpoke) {
        try {
          const synth = await chat({ provider: prov, model: finalModel, apiKey, messages: convo, advanced: advForBody, maxTokens, temperature, onUsage, signal: ctx._signal })
          if (typeof synth === 'string' && synth.trim()) clean = synth.trim()
        } catch (e) { logDebug(ctx, 'error', `Síntesis post-herramienta falló: ${e.message}`, {}) }
      }
      if (typeof onTools === 'function') onTools({ invoked: executed.length > 0, names: executed })
      return clean
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await chat({ provider: prov, model: finalModel, apiKey, messages: convo, tools, advanced: advForBody, maxTokens, temperature, onUsage, onFinish, signal: ctx._signal })
      if (typeof result === 'string') {
        return await finishText(result)
      }
      const message = result?.message
      const toolCalls = message?.tool_calls || []
      if (!toolCalls.length) {
        return await finishText(typeof message?.content === 'string' ? message.content : '')
      }
      convo.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls })
      for (const tc of toolCalls) {
        let args = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch {}
        const name = tc.function?.name
        logDebug(ctx, 'tool_call', `🔧 Herramienta: ${name}`, args)
        const r = onToolCall ? await onToolCall(name, args) : 'OK'
        logDebug(ctx, 'tool_result', `✅ Resultado: ${name}`, r)
        executed.push(name)
        convo.push({ role: 'tool', tool_call_id: tc.id, content: typeof r === 'string' ? r : JSON.stringify(r ?? '') })
      }
      // siguiente ronda, con los resultados de las herramientas ya en contexto
    }
    // Se agotaron las rondas. Antes se redactaba la respuesta final sin más, así que el
    // modelo confirmaba tan tranquilo un pedido al que le faltaban productos. Ahora se le
    // dice, para que avise al cliente en vez de dar por hecho que terminó.
    convo.push({ role: 'system', content: 'AVISO INTERNO: se alcanzó el límite de llamadas a herramientas de este turno, así que puede que alguna acción quede sin ejecutar. NO afirmes que algo se completó si no viste su resultado. Si quedaba trabajo pendiente (por ejemplo productos por agregar o un pedido por confirmar), dilo con naturalidad y pide al cliente que confirme para continuar.' })
    logDebug(ctx, 'flow_run', `⚠ Límite de ${MAX_ROUNDS} rondas de herramientas alcanzado`, { ejecutadas: executed })
    return await finishText('')
  }

  // ── Sin herramientas → completion simple ─────────────────────────────────
  const response = await chat({
    provider: prov, model: finalModel, apiKey, messages,
    maxTokens, temperature,
    advanced: advForBody,
    onUsage, onFinish, signal: ctx._signal,
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
            const why = gate.reason === 'plan_no_ai' ? 'el plan (CRM/Gratuito) no incluye Agente IA'
              : gate.reason === 'contact_limit' ? 'se alcanzó el tope de contactos del plan'
              : `alcanzó el límite de ${gate.max} respuestas IA`
            logDebug(ctx, 'flow_run', `🚫 IA desactivada en este chat: ${why}`, { reason: gate.reason })
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
      // El modelo/proveedor lo gobierna el super admin (default de plataforma). Se usa
      // como fallback cuando el nodo (inline) o el prompt no fijan uno propio, y para
      // reemplazar el legacy 'gpt-4o-mini' que traían por defecto los nodos inline
      // antiguos — así el nodo queda sincronizado con el modelo real de la plataforma.
      const platModel = ctx.account?.defaultPromptModel || ''
      const platProvider = ctx.account?.defaultPromptProvider || ''
      let systemPrompt = ''
      let model = node.data?.modelo || platModel || 'gpt-4o-mini'
      if (model === 'gpt-4o-mini' && platModel && platModel !== 'gpt-4o-mini') model = platModel
      let provider = (model === platModel && platProvider) ? platProvider : undefined
      let temperature = Number(node.data?.temperatura ?? 0.5)
      let promptAdvanced = node.data?.advanced || {}   // parámetros avanzados (max_tokens, top_p, penalties…)
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
        provider = chosen.provider || platProvider || undefined
        model    = chosen.model || platModel || undefined
        const t = chosen.advanced?.temperature ?? chosen.temperature
        if (t != null) temperature = Number(t)
        promptAdvanced = chosen.advanced || {}
        promptLabel = chosen.name || '(sin nombre)'
        const toolIds = chosen.toolIds || []
        assignedTools = (ctx.account?.aiTools || []).filter(t => toolIds.includes(t.id))
        if (Array.isArray(chosen.ragFileIds)) ragFileIds = chosen.ragFileIds
      } else {
        systemPrompt = interpolate(node.data?.prompt || '', ctx.variables)
      }

      // Regla Google: Sheets y Calendario no funcionan con DeepSeek, así que con Google
      // conectado se responde con GPT-5 mini aunque el prompt diga DeepSeek.
      //
      // Antes esto era un bloqueo — el asistente se quedaba mudo hasta que alguien entrara a
      // cambiar el modelo a mano. La política ya escribe el cambio al conectar Google
      // (services/aiModelPolicy.js); esto es la red por si esa escritura no llegó: cuentas
      // que ya tenían Google conectado antes de que la política existiera, prompts
      // restaurados de un backup antiguo, o el modelo heredado del default de plataforma.
      const effProvider = provider || platProvider || detectProvider(model || 'gpt-4o-mini')
      if (effProvider === 'deepseek') {
        let gConn = false
        try { gConn = await require('../../services/google').isGoogleConnected(ctx.accId) } catch {}
        if (gConn) {
          const target = require('../../services/aiModelPolicy').GOOGLE_TARGET
          logDebug(ctx, 'flow_run', `🔗 Google conectado: se usa ${target.label} en lugar de ${model || 'DeepSeek'} (DeepSeek no soporta Sheets/Calendario).`, { from: { provider: effProvider, model }, to: { provider: target.provider, model: target.model }, prompt: promptLabel })
          provider = target.provider
          model    = target.model
        }
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
        try { hoy = new Date().toLocaleDateString('es-CO', { timeZone: _sch.timezone || 'America/Bogota', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) } catch { hoy = new Date().toISOString().slice(0, 10) }
        sysWithRag = `${sysWithRag}\n\n📅 HOY es ${hoy} (zona horaria ${_sch.timezone || 'America/Bogota'}). Para citas usa SIEMPRE la herramienta de agenda (ver_disponibilidad / recomendar_citas / agendar_cita / mover_cita / cancelar_cita / confirmar_cita); NO inventes horarios ni confirmes citas sin la herramienta. Si el cliente confirma su asistencia (p. ej. tras un recordatorio: "sí", "confirmo", "ahí estaré"), llama a confirmar_cita.`
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
      const sentBefore = ctx._sentCount || 0   // para detectar si una herramienta ya envió su mensaje
      const reply = await callAI(ctx, {
        systemPrompt: sysWithRag,
        userPrompt: userMsg || '(sin contexto del usuario, responde con un saludo)',
        model, provider, history, tools: toolDefs,
        onToolCall: (name, args) => execToolCall(ctx, assignedTools, name, args),
        onTools: info => { toolsInvoked = info.invoked },
        advanced: promptAdvanced, temperature,
        onResolved: r => { resolved = r },
      })

      logDebug(ctx, 'flow_run',
        `🤖 Agente IA · ${resolved?.provider || provider || '?'} · ${resolved?.model || model || '?'}`,
        { promptMode: mode, prompt: promptLabel, temperature, maxTokens: promptAdvanced?.maxTokens ?? 'default', turnosDeHistorial: history.length,
          herramientas: assignedTools.map(t => t.name), herramientaActivada: toolsInvoked,
          mensajeUsuario: (userMsg || '').slice(0, 200) })

      if (toolsInvoked) {
        // Si la herramienta ya envió su propio mensaje (transferencia, enviar_recurso,
        // catálogo, link de pago, pedido…), NO se envía además la respuesta del modelo:
        // sería una respuesta duplicada. Solo se entrega cuando la herramienta no comunicó
        // nada (p. ej. la agenda, que devuelve datos para que el modelo redacte).
        const toolSentMsg = (ctx._sentCount || 0) > sentBefore
        logDebug(ctx, 'flow_run', '🔧 Herramienta IA activada' + (toolSentMsg ? ' (mensaje enviado por la herramienta)' : reply ? ' (+ respuesta final)' : ''), {})
        if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, reply || '')
        if (toolSentMsg) {
          ctx._suppressDefaultNext = true            // ya se comunicó: cortar aquí
        } else if (node.data?.sendToUser === false) {
          // El nodo no responde por sí mismo: deja seguir el flujo para que un nodo
          // posterior (p. ej. "message" con {{respuesta_ia}}) entregue la respuesta.
        } else {
          if (reply) await sendBotMsg(ctx, reply)
          ctx._suppressDefaultNext = true
        }
        scheduleMemory(ctx)
        return
      }

      if (node.data?.variable_destino) await setVarBoth(ctx, node.data.variable_destino, reply)
      if (node.data?.sendToUser !== false && reply) await sendBotMsg(ctx, reply)
      scheduleMemory(ctx)
      // El nodo Agente IA es TERMINAL para el flujo de entrada: tras responder, el
      // flujo se corta aquí y no continúa a nodos posteriores. Excepción: si el nodo
      // está configurado para NO responder al usuario (sendToUser:false), se asume
      // que alimenta a un nodo posterior con su variable_destino y el flujo sigue.
      if (node.data?.sendToUser !== false) ctx._suppressDefaultNext = true
    },
  },
  {
    type: 'ai_chat', category: 'ai', label: 'Chat IA',
    async exec(node, ctx) {
      const sys = interpolate(node.data?.prompt || '', ctx.variables)
      const history = await loadHistory(ctx)
      const reply = await callAI(ctx, {
        systemPrompt: sys, userPrompt: ctx.variables?._lastUserMessage || '',
        model: node.data?.modelo, maxTokens: 2000, history,
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

// `resolvePipelineTarget` se exporta para que el proxy público del ticket (motor del
// navegador) resuelva pipeline+etapa con exactamente el mismo criterio.
module.exports = { aiNodes, callAI, execToolCall, buildToolDefs, resolvePipelineTarget }
