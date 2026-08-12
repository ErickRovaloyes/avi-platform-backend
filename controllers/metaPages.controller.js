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

/**
 * Páginas a las que Meta dijo que SÍ concede acceso, pedidas UNA A UNA por su identificador.
 *
 * `/me/accounts` solo devuelve las Páginas donde la persona tiene un rol DIRECTO: las que
 * pertenecen a un portafolio empresarial se quedan fuera, que es el caso más común en cuentas
 * de negocio. El respaldo por `/me/businesses` no sirve aquí porque exige
 * `business_management`, un permiso que la plataforma no pide a propósito.
 *
 * Pero `granular_scopes.pages_show_list` ya trae los identificadores EXACTOS de las Páginas
 * que el usuario marcó en el diálogo. Pedir cada una por su id no necesita permisos extra:
 * es acceso que Meta acaba de conceder. Sin esto, Meta decía "te doy estas Páginas", la
 * plataforma preguntaba por otra vía que no las veía, y concluía que no había ninguna.
 *
 * @returns {Promise<{pages:Array, errores:Array<{id:string,error:string}>}>}
 */
async function pagesByGrantedIds(ids, userToken, fields) {
  const pages = [], errores = []
  for (const id of (ids || []).slice(0, 50)) {
    try {
      const r = await fetch(`${GRAPH}/${encodeURIComponent(id)}?fields=${fields}&access_token=${encodeURIComponent(userToken)}`)
      const d = await r.json().catch(() => ({}))
      // Sin token de página no se puede ni suscribir el webhook ni enviar: no vale.
      if (r.ok && d?.id && d?.access_token) pages.push(d)
      else errores.push({ id, error: d?.error?.message || `HTTP ${r.status}${d?.access_token ? '' : ' (sin token de página)'}` })
    } catch (e) { errores.push({ id, error: e.message }) }
  }
  return { pages, errores }
}

// Construye un mensaje que diga QUÉ falta y CÓMO arreglarlo, no solo que no hubo páginas.
function explainNoPages(info, type, opts = {}) {
  const { usedConfig = false, pageErrors = [] } = opts

  // Esta frase SOLO tiene sentido si se entró con la configuración del Super Panel. Antes se
  // añadía siempre, así que en la vía de "permisos directos" —que no usa ningún Config ID—
  // mandaba a revisar algo que ni siquiera intervenía. Ese fue el consejo equivocado que
  // recibió el usuario.
  const revisaConfig = usedConfig
    ? ' Como estás entrando con la configuración de Facebook Login for Business del Super Panel, '
      + 'revisa que incluya "Páginas" entre los activos que pide y que en el diálogo aparezca el paso para elegirla. '
      + 'Para descartarla, prueba con "Probar pidiendo permisos directos".'
    : ''

  if (!info) {
    return 'No se recibió acceso a ninguna página. En el diálogo de Meta marca (✓) tu Página antes de continuar. '
      + 'Si solo tienes un perfil personal de Facebook, primero crea una Página; si la Página pertenece a un portafolio empresarial, entra con la cuenta que la administra.'
      + revisaConfig
  }

  const faltan = (REQUIRED_SCOPES[type] || REQUIRED_SCOPES.messenger).filter(s => !info.scopes.includes(s))
  if (faltan.length) {
    return `Meta no concedió estos permisos: ${faltan.join(', ')}.`
      + (usedConfig
        ? ' El diálogo usa la configuración del Super Panel e ignora los permisos que pide la plataforma: '
          + 'revisa que esa configuración de Facebook Login for Business incluya los permisos de Página, o déjala vacía para usar el inicio de sesión clásico.'
        : ' Vuelve a intentarlo y acepta todos los accesos que pide el diálogo.')
  }

  const targets = info.granular?.pages_show_list

  // CASO 1 — Meta SÍ concedió Páginas, pero no se pudieron leer. Aquí la culpa NO es de la
  // selección de activos: el usuario hizo su parte. Se da el motivo literal de Meta, que es
  // lo único accionable.
  if (Array.isArray(targets) && targets.length && pageErrors.length) {
    const detalle = pageErrors.slice(0, 3).map(e => `${e.id}: ${e.error}`).join(' · ')
    return `Meta concedió ${targets.length} Página(s) pero no se pudieron leer. Motivo de Meta → ${detalle}. `
      + 'Suele significar que la cuenta con la que entraste no tiene rol de administrador sobre esa Página: '
      + 'pídele al propietario que te asigne acceso a la Página (no solo al portafolio) y reintenta.'
  }

  // CASO 2 — Pasó por el diálogo sin marcar ninguna.
  if (Array.isArray(targets) && targets.length === 0) {
    return 'Entraste en Meta pero no marcaste ninguna Página. Vuelve a intentarlo y en el diálogo marca (✓) la casilla de tu Página antes de continuar.'
  }

  // CASO 3 — Meta ni siquiera informa de Páginas concedidas: la cuenta no administra ninguna
  // que la app pueda ver. Es lo que ocurre cuando la Página está en un portafolio y la persona
  // solo tiene acceso al portafolio, no a la Página.
  return 'Meta concedió los permisos pero no informó de NINGUNA Página para esta cuenta. '
    + 'Comprueba que la cuenta de Facebook con la que entraste aparece como administradora de la Página '
    + '(Configuración de la Página → Accesos a la Página). Si la Página pertenece a un portafolio empresarial, '
    + 'tener acceso al portafolio no basta: hay que tener acceso a la PÁGINA.'
    + revisaConfig
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

    // Respaldo 1: las Páginas que Meta concedió, por su identificador. Va PRIMERO porque no
    // necesita permisos extra —son las que el usuario acaba de marcar— y resuelve el caso de
    // portafolio empresarial, donde /me/accounts viene vacío.
    let info = null
    let erroresPagina = []
    if (!pages.length) {
      info = await debugToken(userToken, appId, appSecret)
      const concedidas = info?.granular?.pages_show_list
      if (Array.isArray(concedidas) && concedidas.length) {
        const r = await pagesByGrantedIds(concedidas, userToken, FIELDS)
        erroresPagina = r.errores
        for (const pg of r.pages) if (!pages.some(q => q.id === pg.id)) pages.push(pg)
        if (r.errores.length) console.warn('[metaPages] páginas concedidas ilegibles:', JSON.stringify(r.errores))
      }
    }

    // Respaldo 2: por portafolio empresarial. Solo aporta si la app tiene business_management,
    // que no se pide; se deja detrás del respaldo 1, que sí funciona sin ese permiso.
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
      if (!info) info = await debugToken(userToken, appId, appSecret)
      console.warn('[metaPages] sin páginas · scopes:', info?.scopes?.join(',') || '(desconocidos)',
        '· granular:', JSON.stringify(info?.granular || {}))
      // `granular` viaja también al frontend: dice sobre QUÉ páginas se concedió cada permiso
      // y es lo único que distingue "no marcó ninguna" de "no tiene acceso a ninguna".
      return res.status(400).json({
        error: explainNoPages(info, type, { usedConfig: !!req.body?.usedConfig, pageErrors: erroresPagina }),
        scopes: info?.scopes || null,
        granular: info?.granular || null,
        // Motivo literal de Meta por cada Página concedida que no se pudo leer. Es lo que
        // convierte "no hay páginas" en algo accionable.
        pageErrors: erroresPagina,
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

      // La CUENTA de Instagram se suscribe aparte de la Página: son dos suscripciones
      // `messaging_seen` es el campo de LECTURA en Instagram; el de Messenger (message_reads)
      // no existe aquí. Y ojo: Instagram NO emite acuse de entrega, solo de lectura, así que
      // en ese canal la paloma va de "enviado" directamente a "visto".
      // distintas y con la de la Página sola no llega ni un DM. Si esta falla, se dice —un
      // canal que se declara conectado y luego no recibe nada es peor que uno que avisa.
      if (type === 'instagram' && page.instagram_business_account?.id) {
        try {
          const ir = await fetch(`${GRAPH}/${page.instagram_business_account.id}/subscribed_apps?subscribed_fields=messages,messaging_seen&access_token=${encodeURIComponent(page.access_token)}`, { method: 'POST' })
          const id_ = await ir.json().catch(() => ({}))
          if (!ir.ok || id_.success === false) {
            const motivo = id_?.error?.message || `HTTP ${ir.status}`
            subscribed = false
            subscribeError = `La cuenta de Instagram no quedó suscrita: ${motivo}`
            console.warn('[metaPages subscribe IG]', motivo)
          }
        } catch (e) {
          subscribed = false
          subscribeError = `La cuenta de Instagram no quedó suscrita: ${e.message}`
        }
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
/**
 * POST /api/meta/pages/diagnose-connect  { userAccessToken }
 *
 * Por qué NO llega ninguna Página, dicho por Meta y sin interpretar.
 *
 * El `diagnose` de más abajo sirve para una página YA conectada; aquí el problema es
 * anterior: la conexión ni siquiera llega a ofrecer una. Sin esto solo queda deducir la causa
 * a partir de una lista vacía, que es como se acabó culpando a la configuración del Super
 * Panel un fallo que no tenía nada que ver.
 */
const diagnoseConnect = async (req, res) => {
  const { userAccessToken } = req.body || {}
  if (!userAccessToken) return res.status(400).json({ error: 'Falta el token de Meta. Entra con Meta y reintenta.' })
  const out = { checks: [] }
  const add = (ok, titulo, detalle) => out.checks.push({ ok, titulo, detalle })
  try {
    const { appId, appSecret } = await globalApp()
    const info = await debugToken(userAccessToken, appId, appSecret)

    if (!info) {
      add(false, 'Token de Meta legible', 'No se pudo inspeccionar el token: faltan el App ID o el App Secret en el Super Panel.')
      return res.json(out)
    }
    add(true, 'Permisos concedidos', info.scopes.join(', ') || '(ninguno)')

    const concedidas = info.granular?.pages_show_list
    if (!Array.isArray(concedidas)) {
      add(false, 'Páginas que Meta concede',
        'Meta no informa de ninguna Página para esta cuenta. Comprueba que la cuenta con la que entraste sea ADMINISTRADORA de la Página '
        + '(Configuración de la Página → Accesos a la Página). Tener acceso al portafolio empresarial no basta.')
    } else if (!concedidas.length) {
      add(false, 'Páginas que Meta concede', 'Pasaste por el diálogo sin marcar ninguna Página. Reintenta y marca (✓) la casilla de tu Página.')
    } else {
      add(true, 'Páginas que Meta concede', `${concedidas.length}: ${concedidas.join(', ')}`)
    }

    // Vía habitual. Puede venir vacía con toda normalidad si la Página está en un portafolio.
    try {
      const r = await fetch(`${GRAPH}/me/accounts?fields=id,name&limit=200&access_token=${encodeURIComponent(userAccessToken)}`)
      const d = await r.json().catch(() => ({}))
      if (!r.ok) add(false, 'Vía habitual (/me/accounts)', d?.error?.message || `HTTP ${r.status}`)
      else if (!(d.data || []).length) add(false, 'Vía habitual (/me/accounts)',
        'Devuelve 0 páginas. Es normal si la Página pertenece a un portafolio empresarial: solo lista aquellas con rol directo. Se usa la vía por identificador.')
      else add(true, 'Vía habitual (/me/accounts)', d.data.map(x => `${x.name} (${x.id})`).join(' · '))
    } catch (e) { add(false, 'Vía habitual (/me/accounts)', e.message) }

    // Lo decisivo: ¿se puede leer cada Página concedida, y tiene Instagram vinculado?
    if (Array.isArray(concedidas) && concedidas.length) {
      const { pages, errores } = await pagesByGrantedIds(concedidas, userAccessToken, 'id,name,access_token,instagram_business_account{id,username}')
      for (const pg of pages) {
        const ig = pg.instagram_business_account
        add(true, `Página "${pg.name}"`, ig ? `Instagram vinculado: @${ig.username || ig.id}` : 'Legible, pero SIN cuenta de Instagram profesional vinculada (sirve para Messenger, no para Instagram).')
      }
      for (const e of errores) add(false, `Página ${e.id}`, `Meta responde: ${e.error}`)
      if (!pages.length) add(false, 'Resultado', 'Meta concede esas Páginas pero ninguna se pudo leer. Suele ser falta de rol de administrador SOBRE LA PÁGINA.')
    }

    out.ok = out.checks.every(c => c.ok)
    res.json(out)
  } catch (err) {
    console.error('[diagnoseConnect]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const diagnose = async (req, res) => {
  const { pageId, pageAccessToken, kind } = req.body || {}
  // Los DM de Instagram NO llegan por el webhook de Páginas: usan el objeto `instagram`, que
  // en el panel de Meta es una suscripción APARTE. Comprobar el de Páginas para un canal de
  // Instagram daba todo por bueno mientras no entraba un solo mensaje.
  const esIg = kind === 'instagram'
  let camposObjeto = []   // campos suscritos del objeto de este canal
  const OBJ = esIg ? 'instagram' : 'page'
  const ETIQUETA = esIg ? 'Webhook de la app para Instagram' : 'Webhook de la app para Páginas'
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

    // QUÉ app se está consultando. Si hay varias apps de Meta en la cuenta y el webhook se
    // configuró en otra, el síntoma es idéntico a «no está suscrito» y desde fuera no hay
    // forma de distinguirlo. Enseñarlo permite compararlo con el del panel de Meta.
    add(true, 'App de Meta consultada', `App ID ${appId} · compáralo con el que aparece en el panel de Meta donde configuraste el webhook: si no coinciden, el webhook está en otra app.`)

    // 1) ¿La app tiene el webhook del objeto que corresponde a ESTE canal?
    //    page → Messenger · instagram → DM de Instagram. Son suscripciones DISTINTAS en el
    //    panel de Meta, y tener la de Messenger no habilita la de Instagram.
    try {
      const r = await fetch(`${GRAPH}/${appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`)
      const d = await r.json().catch(() => ({}))
      const sub = (d.data || []).find(x => x.object === OBJ)
      // Qué objetos tiene suscritos la app REALMENTE. Es lo único que distingue "falta la
      // suscripción" de "Meta la devuelve con otro nombre".
      const suscritos = (d.data || []).map(x => `${x.object} (${(x.fields || []).map(f => f.name || f).join(", ") || "sin campos"})`)
      const base = (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://platform.aviasistente.com').replace(/\/$/, '')
      if (!sub) {
        add(false, ETIQUETA, esIg
          ? 'La app de Meta NO tiene webhook para el objeto "instagram", así que Meta no envía los mensajes directos a ninguna parte. '
            + 'OJO CON LA RUTA: en Messenger → Configuración → Webhooks solo se configura el objeto "page", y ese NO entrega los mensajes de Instagram. '
            + 'El objeto "instagram" se suscribe en OTRO sitio: panel de la app → Webhooks (el producto suelto del menú lateral) → '
            + 'en el desplegable de arriba elige "Instagram" → Suscribirse a este objeto. '
            + `Ahí pon la URL ${base}/api/webhook/instagram (el token de verificación puede ser cualquiera) `
            + 'y suscribe el campo "messages". '
            + 'Si "Instagram" no aparece en ese desplegable, añade primero el producto Instagram a la app. '
            + 'Se configura UNA vez para toda la plataforma, no por cliente.'
            + ` · Lo que Meta responde AHORA para esta app: ${suscritos.length ? suscritos.join(" · ") : "ninguna suscripción"}.` + " Si ahí aparece «instagram» pero el diagnóstico no lo ve, dímelo: significa que Meta lo nombra distinto."
          : 'La app de Meta no tiene webhook para el producto "page", así que Meta no envía los mensajes a ninguna parte. '
            + '1) Si en el panel de tu app no aparece "Messenger" en la lista de productos, añádelo primero (Añadir producto → Messenger). '
            + `2) Luego en Messenger → Configuración → Webhooks pon la URL de devolución: ${base}/api/webhook/messenger. `
            + 'El token de verificación puede ser cualquiera. '
            + '3) Suscribe al menos el campo "messages". Esto se configura UNA vez para toda la plataforma, no por cliente.')
      } else {
        const campos = (sub.fields || []).map(f => f.name || f)
        camposObjeto = campos
        const tieneMessages = campos.includes('messages')
        add(tieneMessages, ETIQUETA,
          tieneMessages
            ? `Activo · campos: ${campos.join(', ')} · URL: ${sub.callback_url || '(no expuesta)'}`
            : `Configurado pero SIN el campo "messages" (tiene: ${campos.join(', ') || 'ninguno'}). Actívalo en Meta → ${esIg ? 'Instagram' : 'Messenger'} → Webhooks.`)
      }
    } catch (e) { add(false, ETIQUETA, 'No se pudo consultar: ' + e.message) }
    
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

    const { accId, agentId, channelId, kind = 'messenger' } = req.body || {}

    // Config REAL del canal. Hace falta para saber si este Instagram se conectó con su propio
    // inicio de sesión (mode 'instagram'): esa vía no cuelga de ninguna Página, usa otra API
    // y otro token, y sin distinguirla el diagnóstico probaba con el token equivocado.
    let cfgCanal = {}
    if (accId && agentId) {
      try {
        const { parseJ } = require('../utils')
        const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agentId, accId])
        const chans = parseJ(ag?.channels, [])
        cfgCanal = (chans.find(c => c.id === channelId) || chans.find(c => c.type === kind) || {}).config || {}
      } catch (e) { console.warn('[diagnose canal]', e.message) }
    }
    const igNativo = esIg && cfgCanal.mode === 'instagram'
    const tokenPerfil = igNativo ? cfgCanal.igAccessToken : pageAccessToken

    // 3) ¿De qué página es REALMENTE el token guardado? Un token de USUARIO, o el de otra
    // página, deja pasar unas llamadas y falla otras: los mensajes llegan, pero leer el
    // perfil de quien escribe da error 100 ("does not exist... missing permissions"). Es
    // indistinguible de un problema de permisos si no se comprueba a quién pertenece.
    let tokenPageId = null
    if (pageAccessToken) {
      try {
        const r = await fetch(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(pageAccessToken)}`)
        const d = await r.json().catch(() => ({}))
        if (!r.ok) {
          add(false, 'Token de la página', `El token guardado no es válido: ${d?.error?.message || `HTTP ${r.status}`}. Reconecta el canal.`)
        } else {
          tokenPageId = String(d.id || '')
          const coincide = tokenPageId === String(pageId)
          add(coincide, 'Token de la página',
            coincide
              ? `Correcto · pertenece a "${d.name || pageId}"`
              : `El token guardado NO es de esta página: es de "${d.name || tokenPageId}" (${tokenPageId}) y el canal está configurado con ${pageId}. `
                + 'Los identificadores de usuario son propios de cada página, así que con el token equivocado no se puede leer ningún perfil. Reconecta el canal.')
        }
      } catch (e) { add(false, 'Token de la página', 'No se pudo comprobar: ' + e.message) }
    }

    // 4) ¿Se puede leer el NOMBRE de quien escribe? Se prueba contra conversaciones REALES
    // de ESTE canal. Sin acotar por canal se podía acabar probando una conversación de
    // pruebas, con un identificador inventado que falla siempre y despista.
    if (accId) {
      try {
        const col = kind === 'instagram' ? 'ig_from' : 'messenger_from'
        const cond = ['account_id=?']; const args = [accId]
        if (agentId) { cond.push('agent_id=?'); args.push(agentId) }
        if (channelId) { cond.push('channel_id=?'); args.push(channelId) }
        cond.push(`${col} IS NOT NULL`)
        cond.push("channel_type=?"); args.push(kind)
        const [rows] = await pool.query(
          `SELECT ${col} AS psid, guest_name, local_vars, id AS conv_id FROM conversations WHERE ${cond.join(' AND ')} ORDER BY updated_at DESC LIMIT 3`, args)
        if (!rows.length) {
          add(false, 'Nombre de quien escribe', 'Aún no hay ninguna conversación de este canal con la que probar. Escribe a la página desde otra cuenta y repite el diagnóstico.')
        } else {
          const mp = require('../services/metaProfile')
          let mejor = null
          for (const c of rows) {
            const probe = await mp.probeProfile(c.psid, tokenPerfil, kind, igNativo ? '' : pageId, igNativo)
            if (probe.ok) { mejor = { probe, c }; break }
            if (!mejor) mejor = { probe, c }
          }
          const { probe, c } = mejor

          // El ENLACE al perfil depende de un dato distinto del nombre: el @usuario. Meta
          // puede devolver el nombre y no el usuario, y entonces el enlace es imposible de
          // componer aunque todo lo demás esté bien. Sin separarlo, el diagnóstico decía
          // "se lee correctamente" mientras la fila «Perfil» seguía sin aparecer.
          // QUÉ HAY GUARDADO. Que Meta devuelva el usuario no significa que haya llegado a la
          // ficha del contacto, y sin mirar la base no hay forma de saber en qué eslabón se
          // corta: si falta el enlace conversación→contacto, si el usuario no se guardó, o si
          // está guardado y el fallo es de la pantalla. Cada caso se arregla en un sitio
          // distinto, así que adivinar sale caro.
          if (esIg) {
            try {
              const { parseJ } = require('../utils')
              const partes = []
              for (const c of rows) {
                const lv = parseJ(c.local_vars, {})
                if (!lv.contact_id) { partes.push(`«${c.guest_name || 'sin nombre'}» → SIN contacto en el CRM`); continue }
                const [[ct]] = await pool.query('SELECT name, extra FROM contacts WHERE id=?', [lv.contact_id])
                if (!ct) { partes.push(`«${c.guest_name}» → apunta a un contacto que ya no existe`); continue }
                const ex = parseJ(ct.extra, {})
                partes.push(`«${ct.name || c.guest_name}» → ${ex.instagramUsername ? '@' + ex.instagramUsername + ' guardado' : 'SIN usuario guardado'}`)
              }
              const guardados = partes.filter(p => /guardado/.test(p) && !/SIN/.test(p)).length
              add(guardados > 0, 'Qué hay guardado en los contactos',
                (partes.join(' · ') || 'sin conversaciones') + '. '
                + (guardados > 0
                    ? 'El enlace al perfil sale en los que tienen usuario.'
                    : 'Ninguno tiene el usuario todavía: se rellena al llegar el próximo mensaje de esa persona. '
                      + 'Si escribes y sigue sin aparecer, el corte está entre leer el perfil y guardarlo — dímelo.'))
            } catch (e) { add(false, 'Qué hay guardado en los contactos', 'No se pudo consultar: ' + e.message) }
          }

          // LA MISMA LLAMADA QUE HACE EL WEBHOOK, no una parecida.
          //
          // probeProfile va sin caché y por la vía que le digo yo; el mensaje real usa otra
          // función y SÍ pasa por la caché. Comparar las dos separa tres cosas que desde
          // fuera se ven idénticas: que Meta no dé el usuario, que la caché esté sirviendo
          // una respuesta vieja sin él, o que el canal esté usando la vía equivocada.
          if (esIg) {
            try {
              const mpv = require('../services/metaProfile')
              const psid = mejor.c.psid
              const vivo = igNativo
                ? await mpv.fetchInstagramNative(psid, cfgCanal.igAccessToken)
                : await mpv.fetchProfile(psid, pageAccessToken, 'instagram', pageId)
              const via = igNativo ? 'Instagram nativo' : 'Página de Facebook'
              const coincide = !!vivo?.username
              add(coincide, 'Lo que recibe el webhook al llegar un mensaje',
                `Vía: ${via}. Devuelve: ${vivo ? `nombre «${vivo.name || '(vacío)'}» · usuario «${vivo.username || '(vacío)'}»` : 'NADA (null)'}. `
                + (coincide
                    ? 'Con esto el usuario se guarda al llegar el próximo mensaje.'
                    : !vivo
                      ? 'Por eso no se guarda nada: con la vía de este canal no se lee el perfil. '
                        + (igNativo ? '' : 'El canal NO está en modo Instagram nativo; si lo conectaste con el inicio de sesión de Instagram, reconéctalo.')
                      : probe.username
                        ? `Aquí falta el usuario pero la prueba directa SÍ lo trae (@${probe.username}): es una respuesta vieja guardada en memoria. Se limpia sola en 6 h, o reiniciando el servicio.`
                        : 'Meta no da el usuario por esta vía.'))
            } catch (e) { add(false, 'Lo que recibe el webhook al llegar un mensaje', 'No se pudo comprobar: ' + e.message) }
          }

          if (esIg) {
            add(!!probe.username, 'Enlace al perfil de Instagram',
              probe.username
                ? `Meta devuelve el usuario (@${probe.username}), así que el enlace se puede componer. `
                  + 'En los chats abiertos antes de esto aparece al llegar su próximo mensaje.'
                : probe.ok
                  ? 'Meta devuelve el NOMBRE pero no el campo "username", que es lo único con lo que se '
                    + 'arma instagram.com/usuario. Sin él no hay enlace posible: suele pasar con perfiles '
                    + 'restringidos o cuando la app no tiene Acceso Avanzado a instagram_business_basic.'
                  : `No se pudo comprobar porque no se lee el perfil. Meta responde: ${probe.error}`)
          }

          const ref = `${c.guest_name || 'sin nombre'} · …${String(c.psid || '').slice(-6)}`
          add(probe.ok, 'Nombre de quien escribe',
            probe.ok
              ? `Se lee correctamente (ejemplo: ${probe.name}). Los chats con nombre provisional se corrigen solos al llegar su próximo mensaje.`
              : `No se puede leer (probado con ${ref}). Meta responde: ${probe.error}`
                + (probe.code === 100 && tokenPageId && tokenPageId !== String(pageId)
                    ? ' · La causa está arriba: el token es de OTRA página.'
                    : probe.code === 100
                      ? ' · Con el token correcto y Acceso Avanzado a pages_messaging, este error suele significar que esa conversación es de pruebas (identificador inventado) o que el usuario borró la conversación con la página.'
                      : ''))
        }
      } catch (e) { add(false, 'Nombre de quien escribe', 'No se pudo comprobar: ' + e.message) }
    }

    // Dos causas que NINGUNA llamada de la API revela y que dejan el canal mudo con todo lo
    // demás en verde. Se nombran siempre en Instagram: si el usuario ve todo ✓ y aun así no
    // le llega nada, esto es lo que le queda por mirar.
      // La paloma de VISTO en Instagram depende de un campo aparte. Y no hay acuse de entrega:
      // en ese canal se pasa de "enviado" a "visto" sin escala.
      if (esIg) {
        const tieneSeen = camposObjeto.includes('messaging_seen')
        add(tieneSeen, 'Palomas de visto (Instagram)',
          tieneSeen
            ? 'El campo messaging_seen está suscrito. Instagram NO emite acuse de ENTREGA, así que la paloma pasa de «enviado» a «visto» sin escala.'
            : 'Falta el campo "messaging_seen" en el webhook del objeto instagram: sin él no llega el aviso de leído y la paloma se queda en «enviado». Añádelo donde suscribiste "messages".')

        // Hay DOS suscripciones y ambas hacen falta: la de la APP (arriba, en el panel de
        // Meta) y la de ESTA CUENTA a la app. La de la cuenta la hacemos nosotros al
        // conectar, y durante un tiempo solo pidió "messages" — por eso podía estar todo
        // verde arriba y aun así no llegar el aviso de leído.
        if (igNativo && cfgCanal.igUserId && cfgCanal.igAccessToken) {
          try {
            const r = await fetch(`https://graph.instagram.com/${encodeURIComponent(cfgCanal.igUserId)}/subscribed_apps?access_token=${encodeURIComponent(cfgCanal.igAccessToken)}`)
            const d = await r.json().catch(() => ({}))
            const campos = (d?.data || []).flatMap(a => a.subscribed_fields || [])
            const ok = campos.includes('messaging_seen')
            add(ok, 'La cuenta de Instagram suscrita al visto',
              ok ? `Correcto · campos: ${campos.join(', ')}`
                 : `La cuenta está suscrita a: ${campos.join(', ') || 'nada'} — falta "messaging_seen". Se corrige solo en menos de 12 h; para no esperar, reconecta el canal.`)
          } catch (e) { add(false, 'La cuenta de Instagram suscrita al visto', 'No se pudo consultar: ' + e.message) }
        }
      } else {
        // Messenger sí tiene acuse de entrega y de lectura, pero son campos DISTINTOS. Tener
        // message_deliveries y no message_reads da exactamente el síntoma de "el entregado
        // funciona y el visto no", y desde fuera parece un fallo de la plataforma.
        const tieneReads = camposObjeto.includes('message_reads')
        add(tieneReads, 'Palomas de visto (Messenger)',
          tieneReads
            ? 'El campo message_reads está suscrito.'
            : `Falta el campo "message_reads" en el webhook del objeto page (tiene: ${camposObjeto.join(', ') || 'ninguno'}). `
              + 'Es un campo aparte de "message_deliveries": por eso el ENTREGADO funciona y el VISTO no. '
              + 'Actívalo en Meta → tu app → Messenger → Configuración → Webhooks, en el mismo sitio donde marcaste "messages".')
      }

    if (esIg) {
      add(true, 'Falta comprobar a mano (la API no lo dice)',
        '1) En la app de Instagram: Configuración → Privacidad → Mensajes → Herramientas conectadas → '
        + '"Permitir el acceso a los mensajes" debe estar ACTIVADO. Viene apagado por defecto y es la causa '
        + 'más habitual de que todo se vea bien y no entre ningún mensaje. '
        + '2) La cuenta debe ser PROFESIONAL (empresa o creador): una personal no entrega mensajes por API.')
    }

    out.ok = out.checks.every(c => c.ok)
    res.json(out)
  } catch (err) {
    console.error('[metaPages diagnose]', err.message)
    res.status(502).json({ error: err.message })
  }
}

module.exports = { connect, subscribe, diagnose, diagnoseConnect }
