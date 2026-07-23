'use strict'
/**
 * Conexión 1-clic de Messenger / Instagram usando la app GLOBAL de Meta
 * (la misma de WhatsApp Coexistence). A partir del token de usuario que devuelve
 * FB.login en el frontend:
 *   1) lo cambia por un token de larga duración (App Secret global, server-side),
 *   2) lista las páginas del usuario (con su page access token e IG vinculado),
 *   3) suscribe la página a los webhooks de la app → los mensajes empiezan a
 *      llegar sin configuración manual.
 * Devuelve la config lista para guardar en el canal del agente.
 */
const pool = require('../db')

const GRAPH = 'https://graph.facebook.com/v19.0'
// Campos de webhook de página (Messenger + IG llegan por la suscripción de la página).
const SUBSCRIBE_FIELDS = 'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads,messaging_referrals'

async function globalApp() {
  const [[r]] = await pool.query('SELECT meta_app_id, meta_app_secret FROM platform_settings WHERE id=1')
  return { appId: r?.meta_app_id || '', appSecret: r?.meta_app_secret || '' }
}

// POST /api/meta/pages/connect  { userAccessToken, type, pageId? }
const connect = async (req, res) => {
  const { userAccessToken, type = 'messenger', pageId } = req.body || {}
  if (!userAccessToken) return res.status(400).json({ error: 'Falta el token de Meta. Reintenta el inicio de sesión.' })
  try {
    const { appId, appSecret } = await globalApp()

    // 1) Token de larga duración (best-effort; si no hay app secret, usa el corto).
    let userToken = userAccessToken
    if (appId && appSecret) {
      try {
        const u = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(userAccessToken)}`
        const r = await fetch(u); const d = await r.json().catch(() => ({}))
        if (r.ok && d.access_token) userToken = d.access_token
      } catch { /* usa el token corto */ }
    }

    // 2) Páginas del usuario (con page token e IG vinculado).
    const pr = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(userToken)}`)
    const pd = await pr.json().catch(() => ({}))
    if (!pr.ok) throw new Error(pd?.error?.message || 'No se pudieron obtener las páginas')
    const pages = pd.data || []
    if (!pages.length) {
      return res.status(400).json({ error: 'No se recibió acceso a ninguna página. En el diálogo de Meta marca (✓) tu Página antes de continuar.' })
    }

    // Si hay varias y aún no se eligió una → devolver la lista para que el usuario elija.
    if (!pageId && pages.length > 1) {
      return res.json({ pages: pages.map(p => ({ id: p.id, name: p.name, hasInstagram: !!p.instagram_business_account })) })
    }

    const page = pageId ? pages.find(p => p.id === pageId) : pages[0]
    if (!page) return res.status(400).json({ error: 'Página no encontrada en tu cuenta de Meta.' })

    if (type === 'instagram' && !page.instagram_business_account?.id) {
      return res.status(400).json({ error: 'Esa página no tiene una cuenta de Instagram profesional vinculada.' })
    }

    // 3) Suscribir la página a los webhooks de la app (con el page token).
    let subscribed = false
    try {
      const sr = await fetch(`${GRAPH}/${page.id}/subscribed_apps?subscribed_fields=${SUBSCRIBE_FIELDS}&access_token=${encodeURIComponent(page.access_token)}`, { method: 'POST' })
      const sd = await sr.json().catch(() => ({}))
      subscribed = sr.ok && sd.success !== false
      if (!sr.ok) console.warn('[metaPages subscribe]', sd?.error?.message)
    } catch (e) { console.warn('[metaPages subscribe]', e.message) }

    const config = {
      pageId: page.id, pageName: page.name, pageAccessToken: page.access_token,
      status: 'connected', subscribed,
    }
    if (type === 'instagram') {
      config.igAccountId = page.instagram_business_account?.id || ''
      config.igUsername = page.instagram_business_account?.username || ''
    }
    res.json({ config })
  } catch (err) {
    console.error('[metaPages connect]', err.message)
    res.status(502).json({ error: err.message || 'No se pudo completar la conexión con Meta' })
  }
}

// POST /api/meta/pages/subscribe  { pageId, pageAccessToken }
// Suscribe la PÁGINA a los webhooks de la app (Messenger/IG). Imprescindible para recibir
// mensajes. El 1-clic ya lo hace; en la conexión MANUAL hay que llamarlo aquí. Server-side
// (evita CORS del navegador contra Graph).
const subscribe = async (req, res) => {
  const { pageId, pageAccessToken } = req.body || {}
  if (!pageId || !pageAccessToken) return res.status(400).json({ ok: false, error: 'Falta Page ID o Page Access Token' })
  try {
    const sr = await fetch(`${GRAPH}/${pageId}/subscribed_apps?subscribed_fields=${SUBSCRIBE_FIELDS}&access_token=${encodeURIComponent(pageAccessToken)}`, { method: 'POST' })
    const sd = await sr.json().catch(() => ({}))
    if (!sr.ok || sd.success === false) return res.json({ ok: false, error: sd?.error?.message || `HTTP ${sr.status}` })
    res.json({ ok: true })
  } catch (e) {
    console.error('[metaPages subscribe]', e.message)
    res.status(502).json({ ok: false, error: e.message })
  }
}

module.exports = { connect, subscribe }
