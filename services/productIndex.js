'use strict'
/**
 * Índice VECTORIAL de productos (WooCommerce / Shopify / Catálogo Meta).
 *
 * Los productos de la tienda se indexan en la tabla `product_index` con:
 *   - content: doc de texto completo (nombre+sku+categorías+precio+stock+descr) → scoring por tokens
 *   - embedding: vector (OpenAI text-embedding-3-small, 512 dims — mismo formato que rag_chunks)
 *     calculado SOLO sobre el subconjunto ESTABLE (sin precio/stock → un cambio de precio no re-embebe)
 *   - product_json: el producto completo (fotos incluidas) → la búsqueda lo devuelve sin llamar a la API
 *
 * La búsqueda del asistente es HÍBRIDA (0.65·coseno + 0.35·tokens + boost por SKU/nombre exacto)
 * con fallback SILENCIOSO a la búsqueda viva de la API si el índice está vacío/deshabilitado/falla.
 *
 * Actualización: webhooks de producto (tiempo real, Woo y Shopify) con cola/debounce de 60s,
 * o programada (cada X horas o día de la semana + hora) vía worker de 15 min. En tiempo real
 * hay además un re-sync de seguridad diario. Config en accounts.woocommerce.vectorIndex
 * (fuente 'store') y accounts.meta_catalog.vectorIndex (fuente 'meta').
 */
const crypto = require('crypto')
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const rag = require('./rag')
const woo = require('./woocommerce')
const shopify = require('./shopify')
const metaCatalog = require('./metaCatalog')

const stripHtml = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()

// ── Config ────────────────────────────────────────────────────────────────────
function normalizeSettings(vi = {}) {
  const dow = (vi.dayOfWeek === null || vi.dayOfWeek === undefined || vi.dayOfWeek === '') ? null
    : Math.min(Math.max(parseInt(vi.dayOfWeek, 10) || 0, 0), 6)
  return {
    enabled: !!vi.enabled,
    mode: vi.mode === 'scheduled' ? 'scheduled' : 'realtime',
    everyHours: Math.min(Math.max(parseInt(vi.everyHours, 10) || 24, 1), 168),
    dayOfWeek: dow,
    hour: Math.min(Math.max(parseInt(vi.hour ?? 3, 10) || 0, 0), 23),
    lastSyncAt: Number(vi.lastSyncAt) || 0,
    count: Number(vi.count) || 0,
    error: vi.error || '',
    webhookSecret: vi.webhookSecret || '',
    webhooks: Array.isArray(vi.webhooks) ? vi.webhooks : [],
  }
}

// Contexto por fuente: config, plataforma efectiva y cómo persistir vectorIndex.
async function loadCtx(accId, source = 'store') {
  if (source === 'pms') {
    // Los alojamientos de un hotel. Solo se indexa lo que los DESCRIBE: tarifas y
    // disponibilidad se siguen pidiendo a la API, porque cambian por fecha.
    const pms = require('./pms')
    const cfg = await pms.loadConfig(accId)
    return {
      cfg, platform: 'pms',
      connected: !!pms.publicConfig(cfg).connected,
      save: async (viNew) => {
        const cur = await pms.loadConfig(accId) || {}
        cur.vectorIndex = viNew
        await pms.saveConfig(accId, cur)
      },
    }
  }
  if (source === 'meta') {
    const cfg = await metaCatalog.getStored(accId)
    return {
      cfg, platform: 'meta',
      connected: !!(cfg?.catalogId && cfg?.accessToken),
      save: async (viNew) => {
        const cur = await metaCatalog.getStored(accId) || {}
        cur.vectorIndex = viNew
        await metaCatalog.saveStored(accId, cur)
      },
    }
  }
  const cfg = await woo.loadConfig(accId)
  const platform = cfg?.platform === 'shopify' ? 'shopify' : 'woocommerce'
  return {
    cfg, platform,
    connected: platform === 'shopify' ? shopify.isEnabled(cfg) : woo.isEnabled(cfg),
    save: async (viNew) => {
      const cur = await woo.loadConfig(accId) || {}
      cur.vectorIndex = viNew
      await woo.saveConfig(accId, cur)
    },
  }
}

async function getSettings(accId, source = 'store') {
  const { cfg } = await loadCtx(accId, source)
  return normalizeSettings(cfg?.vectorIndex)
}
async function saveSettings(accId, source, patch) {
  const ctx = await loadCtx(accId, source)
  const vi = normalizeSettings({ ...normalizeSettings(ctx.cfg?.vectorIndex), ...patch })
  await ctx.save(vi)
  return vi
}

// Key OpenAI efectiva (cuenta → platform_settings) — mismo patrón que rag.controller.
async function resolveOpenaiKey(accId) {
  try {
    const [[a]] = await pool.query('SELECT openai_key FROM accounts WHERE id=?', [accId])
    if (a?.openai_key && a.openai_key.trim()) return a.openai_key.trim()
    const [[pf]] = await pool.query('SELECT openai_key FROM platform_settings WHERE id=1')
    return (pf?.openai_key || '').trim()
  } catch { return '' }
}

// ── Documento del producto (funciones PURAS, testeables) ──────────────────────
// Texto ESTABLE (lo que se embebe): sin precio/stock para que sus cambios no re-embeban.
function buildStableText(p) {
  const parts = [
    `Producto: ${p.name || ''}`,
    p.sku ? `SKU: ${p.sku}` : '',
    (p.categories || []).length ? `Categorías: ${p.categories.join(', ')}` : '',
    p.shortDescription || '',
    p.descriptionFull || p.description || '',
  ]
  return parts.filter(Boolean).join('\n').slice(0, 6000)
}
// Doc completo (para el scoring por tokens): estable + precio + disponibilidad.
function buildContentDoc(p) {
  const stock = p.stockStatus === 'instock' ? 'en stock disponible' : (p.stockStatus === 'outofstock' ? 'agotado' : '')
  return [buildStableText(p), p.price ? `Precio: ${p.price} ${p.currency || ''}`.trim() : '', stock]
    .filter(Boolean).join('\n')
}
function hashContent(text) { return crypto.createHash('sha256').update(String(text || '')).digest('hex') }

// Scoring por tokens (calco del patrón de metaCatalog.searchProducts), normalizado 0..1.
function tokenize(q) { return String(q || '').toLowerCase().split(/[^a-z0-9áéíóúñü]+/i).filter(w => w.length > 1) }
function tokenScore(content, tokens) {
  if (!tokens.length) return 0
  const hay = String(content || '').toLowerCase()
  let sc = 0, max = 0
  for (const t of tokens) {
    const w = t.length >= 4 ? 2 : 1
    max += w
    // Con LIMITES DE PALABRA. Antes era `hay.includes(t)`, subcadena pura: «con» puntuaba
    // dentro de «acondicionado», «balcon» y «confort», y tres palabras funcionales bastaban
    // para que algo pareciera una coincidencia sin serlo.
    if (new RegExp(`(^|[^a-z0-9áéíóúñü])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9áéíóúñü]|$)`, 'i').test(hay)) sc += w
  }
  return max ? sc / max : 0
}

// Ranking híbrido. rows: [{ emb, content, product }]. PURA (el qEmb viene resuelto).
function rankProducts(rows, qEmb, queryText) {
  const tokens = tokenize(queryText)
  const q = String(queryText || '').toLowerCase().trim()
  const out = []
  for (const r of rows) {
    const cos = rag.cosineSimilarity(qEmb, r.emb)
    const tok = tokenScore(r.content, tokens)
    let score = 0.65 * cos + 0.35 * tok
    const sku = String(r.product?.sku || '').toLowerCase()
    const name = String(r.product?.name || '').toLowerCase()
    // El bonus por nombre exige longitud, igual que el del SKU: sin eso, una habitación
    // llamada «Suite» se llevaba +0.15 con la consulta «suite con jacuzzi» por pura
    // coincidencia de substring, sin que «jacuzzi» interviniera.
    if ((sku && q.includes(sku) && sku.length > 2) || (name && (q === name || (name.length > 3 && q.includes(name))))) score += 0.15
    out.push({ product: r.product, score })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

// ── Sync ──────────────────────────────────────────────────────────────────────
const _syncing = new Set()   // `${accId}:${source}` en curso
function isSyncing(accId, source = 'store') { return _syncing.has(`${accId}:${source}`) }

async function fetchAll(accId, source, platform) {
  if (source === 'pms') return require('./pms').listRoomsForIndex(accId)
  if (source === 'meta') return metaCatalog.fetchAllProducts(accId)
  return platform === 'shopify' ? shopify.fetchAllProducts(accId) : woo.fetchAllProducts(accId)
}

async function fullSync(accId, source = 'store') {
  const key = `${accId}:${source}`
  if (_syncing.has(key)) return { ok: false, error: 'Sincronización ya en curso' }
  _syncing.add(key)
  try {
    const ctx = await loadCtx(accId, source)
    if (!ctx.connected) throw new Error('La tienda/catálogo no está conectado.')
    const vi = normalizeSettings(ctx.cfg?.vectorIndex)
    const apiKey = await resolveOpenaiKey(accId)
    if (!apiKey) throw new Error('Falta la API key de OpenAI (cuenta o Super Panel): es necesaria para los embeddings.')

    const products = await fetchAll(accId, source, ctx.platform)
    // Marca de barrido ESTRICTAMENTE creciente entre syncs (2ms de margen evita que
    // dos syncs consecutivas compartan milisegundo y el barrido no distinga la anterior).
    await new Promise(r => setTimeout(r, 2))
    const syncStart = Date.now()
    const [rows] = await pool.query('SELECT product_id, content_hash FROM product_index WHERE account_id=? AND platform=?', [accId, ctx.platform])
    const prevHash = new Map(rows.map(r => [String(r.product_id), r.content_hash]))

    let added = 0, updated = 0
    const toEmbed = [], unchanged = []
    const seen = new Set()
    for (const p of products) {
      const pid = String(p.id)
      if (!pid || seen.has(pid)) continue
      seen.add(pid)
      const stable = buildStableText(p)
      const hash = hashContent(stable)
      const content = buildContentDoc(p)
      if (prevHash.get(pid) === hash) unchanged.push({ p, content })
      else { toEmbed.push({ p, stable, content, hash }); if (prevHash.has(pid)) updated++; else added++ }
    }

    // Sin cambios: refresca product_json/content/synced_at (precio/stock frescos) sin re-embeber.
    for (let i = 0; i < unchanged.length; i += 50) {
      const batch = unchanged.slice(i, i + 50)
      await Promise.all(batch.map(u => pool.query(
        'UPDATE product_index SET content=?, product_json=?, synced_at=?, updated_at=? WHERE account_id=? AND platform=? AND product_id=?',
        [u.content, JSON.stringify(u.p), syncStart, Date.now(), accId, ctx.platform, String(u.p.id)]
      )))
    }

    // Nuevos/cambiados: embeber (lotes internos de 64) + upsert en lotes de 50.
    if (toEmbed.length) {
      const embs = await rag.getEmbeddings(toEmbed.map(t => t.stable), apiKey)
      for (let i = 0; i < toEmbed.length; i += 50) {
        const slice = toEmbed.slice(i, i + 50)
        const values = [], params = []
        for (let j = 0; j < slice.length; j++) {
          const t = slice[j]
          values.push('(?,?,?,?,?,?,?,?,?,?)')
          params.push('pix_' + uid(), accId, ctx.platform, String(t.p.id), t.content, t.hash,
            JSON.stringify(embs[i + j] || []), JSON.stringify(t.p), Date.now(), syncStart)
        }
        await pool.query(
          `INSERT INTO product_index (id, account_id, platform, product_id, content, content_hash, embedding, product_json, updated_at, synced_at)
           VALUES ${values.join(',')}
           ON DUPLICATE KEY UPDATE content=VALUES(content), content_hash=VALUES(content_hash), embedding=VALUES(embedding),
             product_json=VALUES(product_json), updated_at=VALUES(updated_at), synced_at=VALUES(synced_at)`, params)
      }
    }

    // Barrido de eliminados: lo que no se tocó en esta pasada ya no existe en la tienda.
    const [del] = await pool.query('DELETE FROM product_index WHERE account_id=? AND platform=? AND synced_at < ?', [accId, ctx.platform, syncStart])
    const removed = del?.affectedRows || 0

    await ctx.save({ ...vi, lastSyncAt: Date.now(), count: seen.size, error: '' })
    _cache.delete(`${accId}:${ctx.platform}`)
    console.log(`[product index] sync ${accId}/${source}: ${seen.size} productos (+${added} ~${updated} -${removed}, ${unchanged.length} sin cambios)`)
    return { ok: true, count: seen.size, added, updated, removed, skipped: unchanged.length }
  } catch (e) {
    console.warn(`[product index] sync ${accId}/${source} falló:`, e.message)
    try {
      const ctx = await loadCtx(accId, source)
      if (ctx.cfg) await ctx.save({ ...normalizeSettings(ctx.cfg.vectorIndex), error: e.message })
    } catch {}
    return { ok: false, error: e.message }
  } finally { _syncing.delete(key) }
}

// Upsert individual (webhook). `payload` = producto crudo del webhook (si vino).
async function syncOne(accId, source, productId, payload = null) {
  // El PMS no manda webhooks de habitacion: sus cambios entran por la sincronizacion
  // completa. Sin esta guarda, un id de habitacion acabaria pidiendoselo a WooCommerce.
  if (source === 'pms') return
  const ctx = await loadCtx(accId, source)
  if (!ctx.connected) return
  const apiKey = await resolveOpenaiKey(accId)
  if (!apiKey) return
  let p = null
  if (payload) {
    if (ctx.platform === 'shopify') p = shopify.mapRestWebhookProduct(payload, ctx.cfg)
    else p = { ...woo.mapProduct(payload), currency: woo.mapProduct(payload).currency || ctx.cfg?.currency || '', descriptionFull: stripHtml(payload.description).slice(0, 4000) }
  } else {
    try { p = ctx.platform === 'shopify' ? await shopify.getProduct(accId, productId) : await woo.getProduct(accId, productId) } catch { p = null }
  }
  if (!p || !p.id) return
  // Woo: los borradores/privados no deben estar en el índice.
  if (payload && payload.status && !['publish', 'active'].includes(String(payload.status))) { await removeOne(accId, ctx.platform, productId); return }
  const stable = buildStableText(p)
  const hash = hashContent(stable)
  const content = buildContentDoc(p)
  const [[row]] = await pool.query('SELECT id, content_hash FROM product_index WHERE account_id=? AND platform=? AND product_id=?', [accId, ctx.platform, String(p.id)])
  const now = Date.now()
  if (row && row.content_hash === hash) {
    await pool.query('UPDATE product_index SET content=?, product_json=?, updated_at=?, synced_at=? WHERE id=?', [content, JSON.stringify(p), now, now, row.id])
  } else {
    const emb = await rag.getEmbedding(stable, apiKey)
    await pool.query(
      `INSERT INTO product_index (id, account_id, platform, product_id, content, content_hash, embedding, product_json, updated_at, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE content=VALUES(content), content_hash=VALUES(content_hash), embedding=VALUES(embedding),
         product_json=VALUES(product_json), updated_at=VALUES(updated_at), synced_at=VALUES(synced_at)`,
      ['pix_' + uid(), accId, ctx.platform, String(p.id), content, hash, JSON.stringify(emb), JSON.stringify(p), now, now])
  }
  _cache.delete(`${accId}:${ctx.platform}`)
}

async function removeOne(accId, platform, productId) {
  await pool.query('DELETE FROM product_index WHERE account_id=? AND platform=? AND product_id=?', [accId, platform, String(productId)])
  _cache.delete(`${accId}:${platform}`)
}

// ── Cola con debounce (ráfagas de webhooks: imports/ediciones masivas) ─────────
const _queue = new Map()   // `${accId}:${source}` → Map(productId → { action, payload })
let _queueTimer = null
function enqueueChange(accId, source, productId, action, payload = null) {
  const key = `${accId}:${source}`
  if (!_queue.has(key)) _queue.set(key, new Map())
  _queue.get(key).set(String(productId), { action, payload })
  if (!_queueTimer) {
    _queueTimer = setTimeout(() => { _queueTimer = null; flushQueue().catch(e => console.warn('[product index] flush:', e.message)) }, 60 * 1000)
    if (_queueTimer.unref) _queueTimer.unref()
  }
}
async function flushQueue() {
  const entries = [..._queue.entries()]
  _queue.clear()
  for (const [key, changes] of entries) {
    const [accId, source] = key.split(':')
    try {
      if (changes.size > 500) { await fullSync(accId, source); continue }   // ráfaga enorme → un solo resync
      const ctx = await loadCtx(accId, source)
      for (const [productId, ch] of changes) {
        if (ch.action === 'delete') await removeOne(accId, ctx.platform, productId)
        else await syncOne(accId, source, productId, ch.payload)
      }
      // Actualiza el contador visible.
      const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM product_index WHERE account_id=? AND platform=?', [accId, ctx.platform])
      const vi = normalizeSettings(ctx.cfg?.vectorIndex)
      await ctx.save({ ...vi, count: Number(c?.n) || 0 })
    } catch (e) { console.warn(`[product index] cola ${key}:`, e.message) }
  }
}

// ── Búsqueda ──────────────────────────────────────────────────────────────────
const _cache = new Map()   // `${accId}:${platform}` → { at, rows: [{emb, content, product}] }
const CACHE_TTL = 5 * 60 * 1000
async function loadRows(accId, platform) {
  const key = `${accId}:${platform}`
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.rows
  const [rows] = await pool.query('SELECT content, embedding, product_json FROM product_index WHERE account_id=? AND platform=?', [accId, platform])
  const parsed = []
  for (const r of rows) {
    const emb = parseJ(r.embedding, null)
    const product = parseJ(r.product_json, null)
    if (Array.isArray(emb) && product) parsed.push({ emb, content: r.content || '', product })
  }
  _cache.set(key, { at: Date.now(), rows: parsed })
  if (_cache.size > 300) { for (const [k, v] of _cache) if (Date.now() - v.at > CACHE_TTL) _cache.delete(k) }
  return parsed
}

/**
 * Tope por defecto de resultados.
 *
 * Estaba en 8, y ese número era el fallo: preguntar «¿qué tienen dulce?» devolvía OCHO cosas
 * por muchos dulces que hubiera en el catálogo, y el asistente contestaba como si esas ocho
 * fueran todo. No era la búsqueda semántica flojeando; era un tope.
 */
const LIMITE_POR_DEFECTO = 24

/**
 * Búsqueda vectorial con el detalle que necesita quien la llama.
 *
 * → `{ productos, total, recortado }` · `total` es cuántos superan el listón, no cuántos se
 * devuelven: con eso el asistente puede decir «tengo 25, te menciono estos» en vez de dar los
 * primeros como si fueran el catálogo entero.
 *
 * Devuelve null si no es aplicable (sin filas / sin key) para que el llamador use la API viva.
 */
async function searchVectorDetalle(accId, query, { limit = LIMITE_POR_DEFECTO, source = 'store' } = {}) {
  const ctx = await loadCtx(accId, source)
  const rows = await loadRows(accId, ctx.platform)
  if (!rows.length) return null
  const apiKey = await resolveOpenaiKey(accId)
  if (!apiKey) return null
  const qEmb = await rag.getEmbedding(String(query || '').slice(0, 500), apiKey)
  const ranked = rankProducts(rows, qEmb, query)

  // Cada resultado pasa el listón por su cuenta. Antes se comprobaba solo el PRIMERO y salía
  // la lista entera: si el mejor sacaba 0.23 y el siguiente 0.04, el segundo colaba igual.
  let coinciden = ranked.filter(r => r.score >= 0.30)
  // Si el listón alto deja todo fuera pero hay algo razonable, se baja una vez.
  if (!coinciden.length && ranked.length && ranked[0].score >= 0.22) {
    coinciden = ranked.filter(r => r.score >= 0.22)
  }
  const tope = Math.max(1, limit)
  return {
    productos: coinciden.slice(0, tope).map(r => r.product),
    total: coinciden.length,
    recortado: coinciden.length > tope,
  }
}

// Compatible con lo de antes: solo la lista.
async function searchVector(accId, query, opts = {}) {
  const r = await searchVectorDetalle(accId, query, opts)
  return r && r.productos
}

// Búsqueda inteligente con fallback a la búsqueda viva (tienda Woo/Shopify).
async function searchSmart(accId, query, opts = {}) {
  const vi = await getSettings(accId, 'store')
  if (vi.enabled && vi.count > 0) {
    try {
      const r = await searchVector(accId, query, { ...opts, source: 'store' })
      if (Array.isArray(r) && r.length) return r
    } catch (e) { console.warn('[product index] búsqueda vectorial falló, fallback API:', e.message) }
  }
  const store = require('./store')   // lazy: store requiere productIndex de forma lazy también
  return store.searchProducts(accId, query, opts)
}

/**
 * Categorías realmente presentes en el catálogo indexado.
 *
 * Sirve para que una búsqueda SIN resultados no acabe en un "no encontré nada" seco:
 * ese hueco es justo donde el modelo se inventa un producto parecido. Devolviendo lo que
 * SÍ existe, puede ofrecer alternativas reales en vez de rellenar de memoria.
 *
 * Sale del índice local (una consulta, sin llamar a la tienda). Si el índice está vacío
 * o apagado, devuelve [] y quien llama se limita a decir que no hay.
 */
async function listCategories(accId, source = 'store', limit = 12) {
  try {
    const { platform } = await loadCtx(accId, source)
    const [rows] = await pool.query(
      'SELECT product_json FROM product_index WHERE account_id=? AND platform=? LIMIT 500',
      [accId, platform]
    )
    const cuenta = new Map()
    for (const r of rows) {
      let p = null
      try { p = typeof r.product_json === 'string' ? JSON.parse(r.product_json) : r.product_json } catch { continue }
      for (const c of (p?.categories || [])) {
        const nombre = String(typeof c === 'string' ? c : c?.name || '').trim()
        if (nombre) cuenta.set(nombre, (cuenta.get(nombre) || 0) + 1)
      }
    }
    return [...cuenta].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n)
  } catch (e) { console.warn('[product index categorías]', e.message); return [] }
}

// Búsqueda inteligente del Catálogo Meta con fallback al scoring por tokens actual.
async function searchSmartMeta(accId, query, opts = {}) {
  const r = await searchSmartMetaDetalle(accId, query, opts)
  return r.productos
}

/** Igual, pero diciendo cuántos hay en total (ver searchVectorDetalle). */
async function searchSmartMetaDetalle(accId, query, opts = {}) {
  const vi = await getSettings(accId, 'meta')
  if (vi.enabled && vi.count > 0) {
    try {
      const r = await searchVectorDetalle(accId, query, { ...opts, source: 'meta' })
      if (r && r.productos.length) return r
    } catch (e) { console.warn('[product index] búsqueda meta vectorial falló, fallback:', e.message) }
  }
  const lista = await metaCatalog.searchProducts(accId, query, { limit: 100 })
  return { productos: lista, total: lista.length, recortado: false }
}

// ── Programación ──────────────────────────────────────────────────────────────
// PURA: ¿toca resync programado ahora?
function shouldRunScheduledSync(vi, now = Date.now()) {
  if (!vi?.enabled || vi.mode !== 'scheduled') return false
  const last = Number(vi.lastSyncAt) || 0
  if (vi.dayOfWeek !== null && vi.dayOfWeek !== undefined) {
    const d = new Date(now)
    if (d.getDay() !== Number(vi.dayOfWeek) || d.getHours() !== Number(vi.hour ?? 3)) return false
    const hourStart = new Date(now); hourStart.setMinutes(0, 0, 0)
    return last < hourStart.getTime()
  }
  return now - last >= (Number(vi.everyHours) || 24) * 3600e3
}

async function tick() {
  let rows = []
  try {
    ;[rows] = await pool.query(
      "SELECT id, woocommerce, meta_catalog, pms FROM accounts WHERE woocommerce LIKE '%vectorIndex%' OR meta_catalog LIKE '%vectorIndex%' OR pms LIKE '%vectorIndex%'")
  } catch { return }
  const now = Date.now()
  for (const a of rows) {
    for (const [source, raw] of [['store', a.woocommerce], ['meta', a.meta_catalog], ['pms', a.pms]]) {
      const vi = normalizeSettings(parseJ(raw, {})?.vectorIndex)
      if (!vi.enabled || isSyncing(a.id, source)) continue
      const due = vi.mode === 'scheduled'
        ? shouldRunScheduledSync(vi, now)
        : (now - vi.lastSyncAt >= 24 * 3600e3)   // realtime: re-sync de seguridad diario
      if (due) await fullSync(a.id, source)      // secuencial: no saturar API/embeddings
    }
  }
}

let _started = false
function startWorker() {
  if (_started) return
  _started = true
  const t1 = setTimeout(() => tick().catch(() => {}), 90 * 1000)
  const t2 = setInterval(() => tick().catch(() => {}), 15 * 60 * 1000)
  if (t1.unref) t1.unref()
  if (t2.unref) t2.unref()
  console.log('[product index] worker iniciado (tick 15 min)')
}

// Estado para el panel.
async function status(accId, source = 'store') {
  const ctx = await loadCtx(accId, source)
  const vi = normalizeSettings(ctx.cfg?.vectorIndex)
  let dbCount = 0
  try { const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM product_index WHERE account_id=? AND platform=?', [accId, ctx.platform]); dbCount = Number(c?.n) || 0 } catch {}
  return { ...vi, webhookSecret: undefined, connected: ctx.connected, platform: ctx.platform, dbCount, syncing: isSyncing(accId, source) }
}

// IDs de producto ya indexados (para etiquetarlos en el panel de Productos).
async function indexedIds(accId, source = 'store') {
  const ctx = await loadCtx(accId, source)
  const [rows] = await pool.query('SELECT product_id FROM product_index WHERE account_id=? AND platform=?', [accId, ctx.platform])
  return new Set(rows.map(r => String(r.product_id)))
}

// Purga total (cambio de tienda) — la llama saveConfig del controller.
async function purge(accId, platform = null) {
  if (platform) await pool.query('DELETE FROM product_index WHERE account_id=? AND platform=?', [accId, platform])
  else await pool.query('DELETE FROM product_index WHERE account_id=?', [accId])
  for (const k of [..._cache.keys()]) if (k.startsWith(`${accId}:`)) _cache.delete(k)
}

module.exports = {
  getSettings, saveSettings, normalizeSettings, resolveOpenaiKey,
  fullSync, syncOne, removeOne, enqueueChange, flushQueue,
  searchVector, searchVectorDetalle, searchSmart, searchSmartMeta, searchSmartMetaDetalle, listCategories,
  LIMITE_POR_DEFECTO,
  startWorker, tick, status, purge, isSyncing, indexedIds,
  // puras (tests):
  buildStableText, buildContentDoc, hashContent, tokenScore, rankProducts, shouldRunScheduledSync,
}
