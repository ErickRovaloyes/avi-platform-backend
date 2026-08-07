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

// v19.0 como el resto de rutas de Meta de la plataforma. Se comprobó que sigue respondiendo:
// la versión NO era la causa de que no llegaran páginas.
const GRAPH = 'https://graph.facebook.com/v19.0'
// Campos de webhook de página (Messenger + IG llegan por la suscripción de la página).
// message_echoes = mensajes que envía el NEGOCIO (desde la app u otra herramienta) →
// Meta los reenvía para sincronizar el inbox.
const SUBSCRIBE_FIELDS = 'messages,message_echoes,messaging_postbacks,messaging_optins,message_deliveries,message_reads,messaging_referrals'

async function globalApp() {
  const [[r]] = await pool.query('SELECT meta_app_id, meta_app_secret FROM platform_settings WHERE id=1')
  return { appId: r?.meta_app_id || '', appSecret: r?.meta_app_secret || '' }
}

// Permisos mínimos para que el 1-clic funcione, por tipo de canal.
const REQUIRED_SCOPES = {
  messenger: ['pages_show_list', 'pages_messaging'],
  instagram: ['pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'],
}

/**
 * Qué concedió REALMENTE el usuario. Sin esto solo se ve una lista de páginas vacía y hay que
 * adivinar: no se distingue "no marcó ninguna Página" de "la app nunca pidió el permiso" ni de
 * "el Config ID configurado es el de WhatsApp y no incluye permisos de Página". Son tres causas
 * con tres soluciones distintas y el mismo síntoma.
 *
 * `granular_scopes` es la parte importante: dice, permiso a permiso, SOBRE QUÉ PÁGINAS se
 * concedió. Un `pages_show_list` sin `target_ids` significa que el usuario pasó por el diálogo
 * sin marcar ninguna página.
 */
async function debugToken(userToken, appId, appSecret) {
  if (!appId || !appSecret) return null
  try {
    const u = `${GRAPH}/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${encodeURIComponent(appId + '|' + appSecret)}`
    const r = await fetch(u)
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d?.data) return null
    const granular = {}
    for (const g of (d.data.granular_scopes || [])) granular[g.scope] = g.target_ids || null
    return { scopes: d.data.scopes || [], granular }
  } catch { return null }
}

// Construye un mensaje que diga QUÉ falta y CÓMO arreglarlo, no solo que no hubo páginas.
function explainNoPages(info, type) {
  if (!info) {
    return 'No se recibió acceso a ninguna página. En el diálogo de Meta marca (✓) tu Página antes de continuar. '
      + 'Si solo tienes un perfil personal de Facebook, primero crea una Página; si la Página pertenece a un portafolio empresarial, entra con la cuenta que la administra.'
  }
  const faltan = (REQUIRED_SCOPES[type] || REQUIRED_SCOPES.messenger).filter(s => !info.scopes.includes(s))
  if (faltan.length) {
    return `Meta no concedió estos permisos: ${faltan.join(', ')}. `
      + 'Si en el Super Panel hay un "Config ID de páginas" configurado, el diálogo usa ESA configuración e ignora los permisos que pide la plataforma: '
      + 'revisa que esa configuración de Facebook Login for Business incluya los permisos de Página, o déjala vacía para usar el inicio de sesión clásico.'
  }
  const targets = info.granular?.pages_show_list
  if (Array.isArray(targets) && targets.length === 0) {
    return 'Entraste en Meta pero no marcaste ninguna Página. Vuelve a intentarlo y en el diálogo marca (✓) la casilla de tu Página antes de continuar.'
  }
  // Aquí `pages_show_list` SÍ está concedido y aun así no llegó ninguna página. Con ese
  // permiso, /me/accounts devuelve las páginas que el usuario administra, así que lo que
  // falla es la SELECCIÓN DE ACTIVOS: en Facebook Login for Business el diálogo tiene un
  // paso donde se eligen las Páginas a las que la app tendrá acceso, y si la configuración
  // no ofrece Páginas como activo —o se pasa ese paso sin marcar— se conceden los permisos
  // pero no se concede ninguna página.
  //
  // OJO: aquí NO se pide `business_management`. Solo lo necesita el respaldo por portafolio
  // de este mismo archivo, que es un extra; para conectar basta con administrar la Página.
  // Mandar a pedir ese permiso a revisión por esto sería mandar a pedir lo que no hace falta.
  return 'Meta concedió los permisos (incluido pages_show_list) pero no entregó NINGUNA Página. '
    + 'Eso no es cuestión de permisos, sino de la selección de activos: '
    + 'revisa que la configuración de Facebook Login for Business del Super Panel incluya "Páginas" entre los activos que pide, '
    + 'y que en el diálogo aparezca el paso para elegir Página y la marques. '
    + 'Si ese paso no aparece, la configuración no está pidiendo Páginas. '
    + 'Compruébalo con "Probar pidiendo permisos directos": si por ahí sí salen tus páginas, el problema está en esa configuración.'
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
    // limit=200: por defecto Graph pagina de 25 en 25 y quien administra muchas páginas
    // podría no ver la suya en la lista.
    const FIELDS = 'id,name,access_token,instagram_business_account{id,username}'
    const pr = await fetch(`${GRAPH}/me/accounts?fields=${FIELDS}&limit=200&access_token=${encodeURIComponent(userToken)}`)
    const pd = await pr.json().catch(() => ({}))
    if (!pr.ok) throw new Error(pd?.error?.message || 'No se pudieron obtener las páginas')
    let pages = pd.data || []

    // Respaldo: /me/accounts solo devuelve las páginas donde el usuario tiene rol DIRECTO.
    // Las que pertenecen a un portafolio empresarial suelen quedar fuera, y ese es el caso
    // más habitual en cuentas de empresa. Se intenta por el portafolio antes de rendirse.
    if (!pages.length) {
      try {
        const br = await fetch(`${GRAPH}/me/businesses?limit=50&access_token=${encodeURIComponent(userToken)}`)
        const bd = await br.json().catch(() => ({}))
        for (const biz of (bd.data || [])) {
          for (const edge of ['owned_pages', 'client_pages']) {
            const xr = await fetch(`${GRAPH}/${biz.id}/${edge}?fields=${FIELDS}&limit=200&access_token=${encodeURIComponent(userToken)}`)
            const xd = await xr.json().catch(() => ({}))
            for (const p of (xd.data || [])) if (p?.access_token && !pages.some(q => q.id === p.id)) pages.push(p)
          }
        }
      } catch (e) { console.warn('[metaPages businesses]', e.message) }
    }

    if (!pages.length) {
      // Se consulta el token para decir QUÉ falló, en vez de repetir siempre lo mismo.
      const info = await debugToken(userToken, appId, appSecret)
      console.warn('[metaPages] sin páginas · scopes:', info?.scopes?.join(',') || '(desconocidos)',
        '· granular:', JSON.stringify(info?.granular || {}))
      // `granular` viaja también al frontend: dice sobre QUÉ páginas se concedió cada permiso
      // y es lo único que distingue "no marcó ninguna" de "no tiene acceso a ninguna".
      return res.status(400).json({
        error: explainNoPages(info, type),
        scopes: info?.scopes || null,
        granular: info?.granular || null,
      })
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
    // Sin esta suscripción NO llega ningún mensaje. Si falla, el motivo se devuelve al
    // frontend: antes solo quedaba en el log del servidor y el canal aparecía "conectado"
    // mientras el cliente esperaba mensajes que nunca iban a entrar.
    let subscribed = false
    let subscribeError = ''
    try {
      const sr = await fetch(`${GRAPH}/${page.id}/subscribed_apps?subscribed_fields=${SUBSCRIBE_FIELDS}&access_token=${encodeURIComponent(page.access_token)}`, { method: 'POST' })
      const sd = await sr.json().catch(() => ({}))
      subscribed = sr.ok && sd.success !== false
      if (!subscribed) {
        subscribeError = sd?.error?.message || `HTTP ${sr.status}`
        console.warn('[metaPages subscribe]', subscribeError)
      }
    } catch (e) { subscribeError = e.message; console.warn('[metaPages subscribe]', e.message) }

    const config = {
      pageId: page.id, pageName: page.name, pageAccessToken: page.access_token,
      status: 'connected', subscribed,
      ...(subscribeError ? { subscribeError } : {}),
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

// POST /api/meta/pages/diagnose  { pageId, pageAccessToken }
// Comprueba la cadena COMPLETA de recepción de mensajes y dice cuál eslabón está roto.
// Que una página quede "conectada" no significa que vayan a llegar mensajes: hacen falta
// DOS suscripciones distintas, y fallar una de ellas es silencioso.
//
//   1) la APP suscrita al producto correcto con su URL de callback  → /{appId}/subscriptions
//   2) la PÁGINA suscrita a esa app                                 → /{pageId}/subscribed_apps
//
// Sin (1) Meta no tiene a dónde enviar nada; sin (2) no envía los de esa página.
const diagnose = async (req, res) => {
  const { pageId, pageAccessToken } = req.body || {}
  if (!pageId) return res.status(400).json({ error: 'Falta pageId' })
  const out = { pageId, checks: [], ok: false }
  const add = (ok, titulo, detalle) => out.checks.push({ ok, titulo, detalle })
  try {
    const { appId, appSecret } = await globalApp()
    if (!appId || !appSecret) {
      add(false, 'App de Meta configurada', 'Faltan el App ID o el App Secret en el Super Panel.')
      return res.json(out)
    }
    const appToken = `${appId}|${appSecret}`

    // 1) ¿La app tiene webhooks del producto "page" (Messenger) con el campo messages?
    try {
      const r = await fetch(`${GRAPH}/${appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`)
      const d = await r.json().catch(() => ({}))
      const page = (d.data || []).find(x => x.object === 'page')
      if (!page) {
        add(false, 'Webhook de la app para Páginas',
          'La app de Meta NO tiene webhook configurado para el producto "page". En Meta → tu app → Messenger → Configuración → Webhooks: añade la URL de callback y el Verify Token. Sin esto Meta no envía los mensajes a ninguna parte.')
      } else {
        const campos = (page.fields || []).map(f => f.name || f)
        const tieneMessages = campos.includes('messages')
        add(tieneMessages, 'Webhook de la app para Páginas',
          tieneMessages
            ? `Activo · campos: ${campos.join(', ')} · URL: ${page.callback_url || '(no expuesta)'}`
            : `Configurado pero SIN el campo "messages" (tiene: ${campos.join(', ') || 'ninguno'}). Actívalo en Meta → Messenger → Webhooks.`)
      }
    } catch (e) { add(false, 'Webhook de la app para Páginas', 'No se pudo consultar: ' + e.message) }

    // 2) ¿La página está suscrita a ESTA app?
    if (pageAccessToken) {
      try {
        const r = await fetch(`${GRAPH}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(pageAccessToken)}`)
        const d = await r.json().catch(() => ({}))
        if (!r.ok) {
          add(false, 'Página suscrita a la app', d?.error?.message || `HTTP ${r.status}`)
        } else {
          const mine = (d.data || []).find(a => String(a.id) === String(appId))
          const campos = (mine?.subscribed_fields || [])
          add(!!mine && campos.includes('messages'), 'Página suscrita a la app',
            !mine
              ? 'La página NO está suscrita a esta app. Pulsa "Suscribir a webhooks" o reconecta.'
              : `Suscrita · campos: ${campos.join(', ') || 'ninguno'}${campos.includes('messages') ? '' : ' — falta "messages"'}`)
        }
      } catch (e) { add(false, 'Página suscrita a la app', 'No se pudo consultar: ' + e.message) }
    } else {
      add(false, 'Página suscrita a la app', 'Falta el Page Access Token del canal.')
    }

    out.ok = out.checks.every(c => c.ok)
    res.json(out)
  } catch (err) {
    console.error('[metaPages diagnose]', err.message)
    res.status(502).json({ error: err.message })
  }
}

module.exports = { connect, subscribe, diagnose }
