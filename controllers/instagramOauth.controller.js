'use strict'
/**
 * OAuth de Instagram (Instagram Login) — dos extremos:
 *
 *   GET /api/instagram/oauth/start?accId=&agentId=&channelId=   → redirige a Instagram
 *   GET /api/instagram/oauth/callback?code=&state=              → vuelve y conecta el canal
 *
 * El `callback` lo invoca el navegador del usuario tras autorizar, así que NO puede exigir
 * sesión: llega sin cabeceras propias. Lo que autentica la petición es el `state` firmado,
 * emitido en `start` (que sí exige sesión). Sin esa firma, cualquiera podría enganchar su
 * Instagram al canal de otra cuenta.
 */
const pool = require('../db')
const ig = require('../services/instagramLogin')
const socket = require('../services/socket')

// Paso 1 — llevar al usuario a Instagram.
const start = async (req, res) => {
  const { accId, agentId, channelId } = req.query
  if (!accId || !agentId || !channelId) return res.status(400).json({ error: 'Faltan accId, agentId o channelId.' })
  // Que la sesión sea de esa cuenta: si no, se podría emitir un `state` válido para una ajena.
  if (req.user?.type !== 'superadmin' && String(req.user?.accountId) !== String(accId)) {
    return res.status(403).json({ error: 'Esta cuenta no es la tuya.' })
  }
  const url = await ig.authorizeUrl({ accId, agentId, channelId })
  if (!url) return res.status(400).json({ error: 'Instagram no está configurado en el Super Panel (App ID, App Secret y URL de retorno).' })
  res.json({ url })
}

// Página mínima que se muestra al volver de Instagram. Se cierra sola si vino de una pestaña
// nueva; si no, el usuario ve el resultado y vuelve al panel.
const pagina = (ok, mensaje) => `<!doctype html><meta charset="utf-8">
<title>${ok ? 'Instagram conectado' : 'No se pudo conectar'}</title>
<body style="font-family:system-ui,sans-serif;background:#0c0f12;color:#eef1f3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center;padding:24px">
  <div style="font-size:44px">${ok ? '✅' : '⚠️'}</div>
  <h2 style="margin:12px 0 6px;font-size:19px">${ok ? 'Instagram conectado' : 'No se pudo conectar'}</h2>
  <p style="color:#8b95a0;font-size:14px;line-height:1.5">${mensaje}</p>
  <p style="color:#66727c;font-size:12px">Puedes cerrar esta pestaña y volver al panel.</p>
</div>
<script>try{window.opener&&window.opener.postMessage({avi:'instagram-oauth',ok:${ok}},'*');setTimeout(()=>window.close(),${ok ? 1200 : 6000})}catch(e){}</script>`

// Paso 2 — Instagram devuelve el código.
const callback = async (req, res) => {
  const { code, state, error, error_description: desc } = req.query
  res.set('Content-Type', 'text/html; charset=utf-8')

  if (error) return res.send(pagina(false, desc || 'Cancelaste la autorización en Instagram.'))
  if (!code || !state) return res.send(pagina(false, 'Instagram no devolvió el código de autorización.'))

  try {
    const { appSecret } = await ig.config()
    if (!appSecret) return res.send(pagina(false, 'Instagram no está configurado en el Super Panel.'))

    const st = ig.verifyState(state, appSecret)
    if (!st?.accId || !st?.agentId || !st?.channelId) {
      return res.send(pagina(false, 'La autorización no es válida o fue manipulada. Vuelve a intentarlo desde el panel.'))
    }
    // Caducidad: un `state` viejo reutilizado no debe servir.
    if (Date.now() - Number(st.ts || 0) > 15 * 60000) {
      return res.send(pagina(false, 'La autorización caducó (más de 15 minutos). Vuelve a intentarlo.'))
    }

    const tok = await ig.exchangeCode(code)
    if (!tok.ok) return res.send(pagina(false, `Instagram no entregó el token: ${tok.error}`))

    const info = await ig.accountInfo(tok.token)
    if (!info.ok) return res.send(pagina(false, `No se pudo leer la cuenta de Instagram: ${info.error}`))

    // Suscribir los webhooks. Si falla, se conecta igual pero se avisa: sin esto entran cero
    // mensajes, y descubrirlo por silencio es lo peor que puede pasar.
    const sub = await ig.subscribe(info.userId || tok.userId, tok.token)

    const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [st.agentId, st.accId])
    if (!ag) return res.send(pagina(false, 'El agente ya no existe.'))
    let chans = []
    try { chans = typeof ag.channels === 'string' ? JSON.parse(ag.channels) : (ag.channels || []) } catch { chans = [] }
    const ch = chans.find(c => c.id === st.channelId)
    if (!ch) return res.send(pagina(false, 'El canal ya no existe.'))

    ch.config = {
      ...(ch.config || {}),
      // `mode` es lo que distingue este canal de los conectados por Página: de él dependen el
      // envío, la recepción y la lectura del perfil.
      mode: 'instagram',
      igUserId: info.userId || tok.userId,
      igUsername: info.username,
      igAccessToken: tok.token,
      igTokenExpiry: tok.expiresAt,
      igPhoto: info.photo || '',
      // Qué campos se suscribieron de verdad. El worker compara esto con la lista actual y
      // resuscribe los canales que se conectaron antes de añadir alguno — así no hay que
      // reconectar a mano cada vez que se necesite un campo nuevo del webhook.
      ...(sub.ok ? { camposWebhook: ig.CAMPOS } : {}),
    }
    ch.status = 'connected'
    await pool.query('UPDATE agents SET channels=? WHERE id=?', [JSON.stringify(chans), st.agentId])
    socket.emit(st.accId, 'account:updated', { accId: st.accId })

    console.log(`[instagramLogin] canal ${st.channelId} conectado como @${info.username} (${info.userId})`)
    res.send(pagina(true, sub.ok
      ? `Conectado como <strong>@${info.username}</strong>. Ya puedes recibir y responder mensajes.`
      : `Conectado como <strong>@${info.username}</strong>, pero la suscripción a mensajes falló: ${sub.error}. Los DM no llegarán hasta resolverlo.`))
  } catch (err) {
    console.error('[instagram oauth callback]', err)
    res.send(pagina(false, 'Error interno al conectar. Inténtalo de nuevo.'))
  }
}

module.exports = { start, callback }
