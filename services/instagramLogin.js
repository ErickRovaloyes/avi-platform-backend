'use strict'
/**
 * Instagram API con Instagram Login — conectar una cuenta de Instagram SIN Página de Facebook.
 *
 * Es un producto distinto del de Facebook, no una variante:
 *   · credenciales propias (Instagram App ID / Secret, distintas de las de la app de Facebook),
 *   · inicio de sesión por REDIRECCIÓN, no con la ventana emergente del SDK de Facebook,
 *   · token propio de Instagram con caducidad de 60 días, renovable,
 *   · envío por graph.instagram.com en vez de por el token de la Página.
 *
 * El flujo por Página se mantiene intacto: hay canales ya conectados así y es el único
 * aprobado hasta que Meta revise los permisos nuevos.
 *
 * Requiere `instagram_business_basic` e `instagram_business_manage_messages`, ambos sujetos a
 * revisión de Meta. Sin `instagram_app_id` configurado, todo esto queda apagado.
 */
const crypto = require('crypto')
const pool = require('../db')

const AUTH_BASE = 'https://www.instagram.com/oauth/authorize'
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token'
const GRAPH = 'https://graph.instagram.com'

const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages']

// Un token largo dura 60 días. Se renueva bastante antes para que un fallo puntual de red no
// deje el canal muerto: si se esperase al último día, un solo fallo lo tumbaría.
const TOKEN_TTL_MS = 60 * 24 * 3600 * 1000
const RENEW_BEFORE_MS = 10 * 24 * 3600 * 1000

async function config() {
  const [[r]] = await pool.query(
    'SELECT instagram_app_id, instagram_app_secret, instagram_redirect_uri FROM platform_settings WHERE id=1'
  )
  return {
    appId: r?.instagram_app_id || '',
    appSecret: r?.instagram_app_secret || '',
    redirect: r?.instagram_redirect_uri || '',
  }
}

/** ¿Está configurado el inicio nativo? Si no, la interfaz no lo ofrece. */
async function isConfigured() {
  const c = await config()
  return !!(c.appId && c.appSecret && c.redirect)
}

// ── `state`: a qué canal pertenece esta autorización ─────────────────────────
// Va FIRMADO con el secreto de la app. Sin firma, cualquiera podría fabricar un `state` con
// el identificador de otra cuenta y enganchar SU Instagram al canal de un tercero: el callback
// no tiene forma de saber quién inició el flujo salvo por este dato.
function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}
function verifyState(state, secret) {
  const [body, mac] = String(state || '').split('.')
  if (!body || !mac) return null
  const esperado = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  // Comparación en tiempo constante: una comparación normal filtra la firma byte a byte.
  const a = Buffer.from(mac), b = Buffer.from(esperado)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
}

/** URL a la que se manda al usuario para que autorice. */
async function authorizeUrl({ accId, agentId, channelId }) {
  const c = await config()
  if (!c.appId || !c.appSecret || !c.redirect) return null
  const state = signState({ accId, agentId, channelId, ts: Date.now() }, c.appSecret)
  const q = new URLSearchParams({
    client_id: c.appId,
    redirect_uri: c.redirect,
    scope: SCOPES.join(','),
    response_type: 'code',
    state,
  })
  return `${AUTH_BASE}?${q.toString()}`
}

/**
 * Código → token corto → token largo (60 días).
 *
 * Son DOS pasos y hay que hacer los dos: el token corto caduca en una hora, así que guardarlo
 * dejaría el canal funcionando esta tarde y muerto mañana.
 */
async function exchangeCode(code) {
  const c = await config()
  if (!c.appId || !c.appSecret) return { ok: false, error: 'Instagram no está configurado en el Super Panel.' }

  const form = new URLSearchParams({
    client_id: c.appId,
    client_secret: c.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: c.redirect,
    code,
  })
  let corto
  try {
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d?.access_token) return { ok: false, error: d?.error_message || d?.error?.message || `HTTP ${r.status}` }
    corto = d
  } catch (e) { return { ok: false, error: e.message } }

  try {
    const u = `${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(c.appSecret)}&access_token=${encodeURIComponent(corto.access_token)}`
    const r = await fetch(u)
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d?.access_token) return { ok: false, error: d?.error?.message || `HTTP ${r.status} al canjear el token largo` }
    return {
      ok: true,
      token: d.access_token,
      expiresAt: Date.now() + (Number(d.expires_in) ? Number(d.expires_in) * 1000 : TOKEN_TTL_MS),
      userId: String(corto.user_id || ''),
    }
  } catch (e) { return { ok: false, error: e.message } }
}

/** Datos de la cuenta conectada (para mostrar @usuario en vez de un identificador). */
async function accountInfo(token) {
  try {
    const r = await fetch(`${GRAPH}/me?fields=user_id,username,name,profile_picture_url&access_token=${encodeURIComponent(token)}`)
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: d?.error?.message || `HTTP ${r.status}` }
    return { ok: true, userId: String(d.user_id || d.id || ''), username: d.username || '', name: d.name || '', photo: d.profile_picture_url || '' }
  } catch (e) { return { ok: false, error: e.message } }
}

// Campos que necesita la cuenta. `messages` trae los DM; `messaging_seen` es el aviso de
// LEÍDO, y sin él la paloma se queda en «enviado» para siempre: se pedía solo `messages`,
// así que en las cuentas conectadas por aquí Meta nunca tuvo motivo para avisar del visto.
// (Instagram no tiene campo de ENTREGA: en ese canal se pasa de enviado a visto sin escala.)
const CAMPOS = 'messages,messaging_seen'

/** Suscribe la cuenta a los webhooks de mensajes. Sin esto no llega ningún DM. */
async function subscribe(igUserId, token) {
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(igUserId)}/subscribed_apps?subscribed_fields=${CAMPOS}&access_token=${encodeURIComponent(token)}`, { method: 'POST' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d?.success) return { ok: false, error: d?.error?.message || `HTTP ${r.status}` }
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
}

/** Renueva un token largo (devuelve otros 60 días). */
async function refreshToken(token) {
  try {
    const r = await fetch(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`)
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d?.access_token) return { ok: false, error: d?.error?.message || `HTTP ${r.status}` }
    return { ok: true, token: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) ? Number(d.expires_in) * 1000 : TOKEN_TTL_MS) }
  } catch (e) { return { ok: false, error: e.message } }
}

/** ¿Toca renovar este token? PURA, para poder probarla con un reloj fijo. */
function needsRefresh(expiresAt, now = Date.now()) {
  if (!expiresAt) return false
  return Number(expiresAt) - now <= RENEW_BEFORE_MS
}

/**
 * Rellena el @usuario de Instagram que falte en los contactos ya existentes.
 *
 * El usuario se guarda cuando llega un mensaje, así que un chat abierto antes de que esto
 * existiera se queda sin enlace al perfil hasta que esa persona vuelva a escribir — y hay
 * conversaciones que no se reabren nunca. Esto las completa sin esperar.
 *
 * Se limita a unos pocos perfiles por vuelta: no hay prisa (se repite cada 12 h) y no tiene
 * sentido castigar a la API de Meta por algo que no urge.
 */
const MAX_POR_VUELTA = 25

async function rellenarUsuarios(agentId, cfg) {
  let hechos = 0
  try {
    const [convos] = await pool.query(
      `SELECT id, ig_from, local_vars FROM conversations
       WHERE agent_id=? AND channel_type='instagram' AND ig_from IS NOT NULL
       ORDER BY updated_at DESC LIMIT 200`, [agentId])
    const metaProfile = require('./metaProfile')

    for (const c of convos) {
      if (hechos >= MAX_POR_VUELTA) break
      let lv = {}; try { lv = JSON.parse(c.local_vars || '{}') } catch {}
      if (!lv.contact_id) continue

      const [[ct]] = await pool.query('SELECT extra FROM contacts WHERE id=?', [lv.contact_id])
      if (!ct) continue
      let ex = {}; try { ex = JSON.parse(ct.extra || '{}') } catch {}
      if (ex.instagramUsername) continue          // ya lo tiene

      // Se lee por la MISMA vía que usaría un mensaje de ese canal: la nativa va por
      // graph.instagram.com con su token propio, y la de Página por graph.facebook.com.
      // Usar la que no toca devuelve null y el repaso no rellenaría nunca nada.
      const perfil = cfg.mode === 'instagram'
        ? await metaProfile.fetchInstagramNative(c.ig_from, cfg.igAccessToken)
        : await metaProfile.fetchProfile(c.ig_from, cfg.pageAccessToken, 'instagram', cfg.pageId)
      hechos++
      if (!perfil?.username) continue             // Meta no lo da para este; ya se reintentará

      ex.instagramUsername = perfil.username
      await pool.query('UPDATE contacts SET extra=? WHERE id=?', [JSON.stringify(ex), lv.contact_id])
      console.log('[instagramLogin] usuario rellenado:', perfil.username, '→ contacto', lv.contact_id)
    }
  } catch (e) { console.warn('[instagramLogin rellenarUsuarios]', e.message) }
  return hechos
}

// ── Worker de renovación ─────────────────────────────────────────────────────
// Sin esto el canal deja de funcionar a los 60 días sin que nadie sepa por qué: los mensajes
// simplemente dejarían de enviarse.
async function tick() {
  try {
    const [rows] = await pool.query("SELECT id, channels FROM agents WHERE channels LIKE '%\"instagram\"%'")
    for (const ag of rows) {
      let chans = []
      try { chans = typeof ag.channels === 'string' ? JSON.parse(ag.channels) : (ag.channels || []) } catch { continue }
      let cambio = false
      for (const ch of chans) {
        const cfg = ch?.config
        if (ch?.type !== 'instagram' || !cfg) continue

        // El repaso de @usuarios vale para CUALQUIER canal de Instagram. Estaba dentro del
        // bloque de solo-nativos, así que en los canales conectados por Página no se
        // ejecutaba nunca — y son justo los que más se quedan sin el usuario, porque su vía
        // de respaldo (la lista de conversaciones) devuelve el nombre y no siempre el resto.
        await rellenarUsuarios(ag.id, cfg)

        // De aquí para abajo, solo lo del inicio de sesión nativo: token propio y su renovación.
        if (cfg.mode !== 'instagram' || !cfg.igAccessToken) continue

        // Los canales conectados ANTES de añadir messaging_seen se quedaron suscritos solo a
        // `messages`, y sin eso no llega el aviso de leído. Se resuscriben aquí, una vez, en
        // lugar de pedirte que reconectes todos los canales a mano: volver a suscribir es
        // idempotente, así que repetirlo no rompe nada.
        if (cfg.camposWebhook !== CAMPOS) {
          const s = await subscribe(cfg.igUserId, cfg.igAccessToken)
          if (s.ok) { cfg.camposWebhook = CAMPOS; cambio = true; console.log('[instagramLogin] resuscrito a', CAMPOS, cfg.igUserId) }
          else console.warn('[instagramLogin] no se pudo resuscribir', cfg.igUserId, s.error)
        }

        // Completa los enlaces al perfil que falten en los contactos ya creados.
        await rellenarUsuarios(ag.id, cfg)

        if (!needsRefresh(cfg.igTokenExpiry)) continue
        const r = await refreshToken(cfg.igAccessToken)
        if (r.ok) { cfg.igAccessToken = r.token; cfg.igTokenExpiry = r.expiresAt; cambio = true; console.log('[instagramLogin] token renovado', cfg.igUserId) }
        else console.warn('[instagramLogin] no se pudo renovar', cfg.igUserId, r.error)
      }
      if (cambio) await pool.query('UPDATE agents SET channels=? WHERE id=?', [JSON.stringify(chans), ag.id])
    }
  } catch (e) { console.warn('[instagramLogin tick]', e.message) }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(() => tick().catch(() => {}), 12 * 3600 * 1000)   // dos veces al día basta
  _timer.unref?.()
  setTimeout(() => tick().catch(() => {}), 60000)
}

module.exports = {
  config, isConfigured, authorizeUrl, exchangeCode, accountInfo, subscribe,
  refreshToken, needsRefresh, signState, verifyState, startWorker, tick, SCOPES, GRAPH, CAMPOS,
  rellenarUsuarios,
}
