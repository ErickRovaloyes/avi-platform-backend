'use strict'
/**
 * Octorate: autorización OAuth2 y avisos automáticos (webhooks).
 *
 * Dos caminos distintos y con reglas distintas:
 *
 *   · Autorizar es cosa del dueño de la cuenta y va con sesión.
 *   · El webhook lo llama Octorate desde fuera, SIN sesión. Se identifica por un secreto en la
 *     propia URL, porque la API no firma sus notificaciones. Sin ese secreto cualquiera podría
 *     inventarse reservas en el inbox de un cliente.
 */
const crypto = require('crypto')
const pool = require('../db')
const oct = require('../services/octorate')
const pms = require('../services/pms')
const socket = require('../services/socket')

const EVENTOS = ['RESERVATION_CREATED', 'RESERVATION_CHANGE', 'RESERVATION_CANCELLED', 'RESERVATION_CONFIRMED', 'CHAT_MESSAGE_RECEIVED']

const publicUrl = () => (process.env.PUBLIC_URL || 'https://platform.aviasistente.com').replace(/\/+$/, '')

/**
 * Las credenciales de la aplicacion de partner de Octorate.
 *
 * Viven en `platform_settings` y se editan en el superpanel, igual que las de Meta, Instagram
 * y Google. NO en variables de entorno: el docker-compose del VPS solo pasa al contenedor las
 * que lista explicitamente, asi que unas variables nuevas no llegarian nunca. Se aceptan de
 * todos modos como respaldo, por si alguien prefiere ponerlas ahi.
 */
async function credencialesDePlataforma() {
  try {
    const [[r]] = await pool.query('SELECT octorate_client_id, octorate_client_secret FROM platform_settings WHERE id=1')
    return {
      clientId: r?.octorate_client_id || process.env.OCTORATE_CLIENT_ID || '',
      clientSecret: r?.octorate_client_secret || process.env.OCTORATE_CLIENT_SECRET || '',
    }
  } catch {
    return { clientId: process.env.OCTORATE_CLIENT_ID || '', clientSecret: process.env.OCTORATE_CLIENT_SECRET || '' }
  }
}
function esDueno(user, accId) {
  if (!user) return 'No hay sesión.'
  if (user.type === 'superadmin' || user.isImpersonating) return null
  if (user.type !== 'member') return 'No tienes acceso a esta cuenta.'
  if (String(user.accountId) !== String(accId)) return 'Esta cuenta no es la tuya.'
  if (!String(user.roleId || '').startsWith('role_owner') && !user.permissions?.admins) return 'No tienes permiso para conectar el PMS.'
  return null
}

// ── Autorización ──────────────────────────────────────────────────────────────

/**
 * Devuelve la URL a la que mandar al hotelero para que autorice.
 *
 * El `state` se guarda en la configuración y se comprueba a la vuelta: sin eso, cualquiera
 * podría inducir a un usuario a conectar la cuenta de OTRO (CSRF sobre el OAuth).
 */
const iniciarOauth = async (req, res) => {
  const { accId } = req.params
  const error = esDueno(req.user, accId)
  if (error) return res.status(403).json({ error })
  try {
    const { clientId } = await credencialesDePlataforma()
    if (!clientId) return res.status(400).json({ error: 'Falta el Client ID de Octorate. Configúralo en el superpanel → Integraciones antes de conectar.' })

    const cfg = (await pms.loadConfig(accId)) || {}
    const state = crypto.randomBytes(16).toString('hex')
    const { _accId, ...limpio } = cfg
    await pms.saveConfig(accId, { ...limpio, provider: 'octorate', oauthState: state, oauthStateAt: Date.now() })

    res.json({
      url: oct.urlDeAutorizacion({ clientId, redirectUri: `${publicUrl()}/api/octorate/callback`, state: `${accId}:${state}` }),
    })
  } catch (err) { console.error('[octorate oauth]', err); res.status(500).json({ error: 'Error interno' }) }
}

/** La vuelta de Octorate. No lleva sesión: la identidad va en el `state`. */
const callbackOauth = async (req, res) => {
  const { code, state } = req.query
  const pagina = (titulo, detalle) =>
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center">
     <h2>${titulo}</h2><p style="color:#555">${detalle}</p><p>Ya puedes cerrar esta ventana.</p></body>`
  try {
    const [accId, valor] = String(state || '').split(':')
    if (!accId || !valor) return res.status(400).send(pagina('Falta información', 'La respuesta de Octorate llegó incompleta.'))

    const cfg = (await pms.loadConfig(accId)) || {}
    // El state es de un solo uso y caduca: si no coincide, la autorización no la inició esta cuenta.
    if (!cfg.oauthState || cfg.oauthState !== valor || Date.now() - Number(cfg.oauthStateAt || 0) > 15 * 60 * 1000) {
      return res.status(400).send(pagina('La autorización no es válida', 'Vuelve a intentarlo desde Zona IA → PMS.'))
    }

    const tokens = await oct.canjearCodigo({
      code,
      ...(await credencialesDePlataforma()),
      redirectUri: `${publicUrl()}/api/octorate/callback`,
    })

    const { _accId, oauthState, oauthStateAt, ...limpio } = cfg
    await pms.saveConfig(accId, { ...limpio, provider: 'octorate', oauth: tokens })

    // Registrar los avisos aquí y no en un botón aparte: si se deja para después, se olvida y
    // el cliente cree que la conexión quedó completa.
    let avisos = 0
    try { avisos = await registrarAvisos(accId) } catch (e) { console.warn('[octorate avisos]', e.message) }

    socket.emit(accId, 'account:updated', { accId })
    res.send(pagina('Octorate conectado ✓', `La conexión quedó lista${avisos ? ` y se activaron ${avisos} avisos automáticos` : ''}.`))
  } catch (err) {
    console.error('[octorate callback]', err)
    res.status(500).send(pagina('No se pudo completar', err.message || 'Error interno'))
  }
}

// ── Avisos automáticos ────────────────────────────────────────────────────────

/** Suscribe la cuenta a los eventos de Octorate. Devuelve cuántos quedaron activos. */
async function registrarAvisos(accId) {
  const cfg = await pms.loadConfig(accId)
  if (!cfg?.oauth?.accessToken && !cfg?.oauth?.refreshToken) return 0
  const secreto = cfg.webhookSecret || crypto.randomBytes(18).toString('hex')
  if (!cfg.webhookSecret) {
    const { _accId, ...limpio } = cfg
    await pms.saveConfig(accId, { ...limpio, webhookSecret: secreto })
  }
  const url = `${publicUrl()}/api/octorate/webhook/${accId}/${secreto}`
  let ok = 0
  for (const evento of EVENTOS) {
    // Uno a uno y tolerante: que un evento no esté disponible en el plan del cliente no puede
    // dejar sin avisos a los demás.
    try { await oct.suscribir(accId, { ...cfg, webhookSecret: secreto }, evento, url); ok++ }
    catch (e) { console.warn(`[octorate] no se pudo suscribir a ${evento}:`, e.message) }
  }
  return ok
}

const reactivarAvisos = async (req, res) => {
  const { accId } = req.params
  const error = esDueno(req.user, accId)
  if (error) return res.status(403).json({ error })
  try { res.json({ ok: true, eventos: await registrarAvisos(accId) }) }
  catch (err) { res.status(400).json({ error: err.message || 'No se pudieron activar los avisos' }) }
}

/**
 * El webhook. Lo llama Octorate, sin sesión.
 *
 * Se responde 200 SIEMPRE que el secreto sea válido, incluso si el procesado falla: si se
 * devuelve un error, Octorate reintenta, y un fallo nuestro se convierte en una tormenta de
 * reintentos. El error se registra y se sigue.
 */
const webhook = async (req, res) => {
  const { accId, secreto } = req.params
  try {
    const cfg = await pms.loadConfig(accId)
    if (!cfg?.webhookSecret || cfg.webhookSecret !== secreto) {
      // Sin filtrar si la cuenta existe: un 404 que distinga cuentas es un oráculo gratis.
      return res.status(404).json({ error: 'No encontrado' })
    }
    res.json({ ok: true })                       // se contesta ya; el trabajo va después
    procesarAviso(accId, cfg, req.body).catch(e => console.error('[octorate webhook]', e.message))
  } catch (err) {
    console.error('[octorate webhook]', err)
    res.status(200).json({ ok: true })
  }
}

/** Reparte el aviso según su tipo. */
async function procesarAviso(accId, cfg, cuerpo) {
  const evento = String(cuerpo?.event || cuerpo?.type || '').toUpperCase()
  if (evento === 'CHAT_MESSAGE_RECEIVED') return require('../services/octorateChat').entraMensaje(accId, cfg, cuerpo)
  if (evento.startsWith('RESERVATION')) return avisoDeReserva(accId, cfg, evento, cuerpo)
  console.warn('[octorate] evento sin manejar:', evento)
}

/** Una reserva creada, cambiada o cancelada en cualquier portal → aviso en la plataforma. */
async function avisoDeReserva(accId, cfg, evento, cuerpo) {
  const id = cuerpo?.reservation || cuerpo?.reservationId || cuerpo?.id
  const acc = cuerpo?.accommodation || cfg.propertyId
  let r = null
  try { if (id && acc) r = await oct.verReserva(accId, cfg, acc, id) } catch (e) { console.warn('[octorate reserva]', e.message) }

  const etiqueta = {
    RESERVATION_CREATED: 'Reserva nueva',
    RESERVATION_CONFIRMED: 'Reserva confirmada',
    RESERVATION_CHANGE: 'Reserva modificada',
    RESERVATION_CANCELLED: 'Reserva cancelada',
  }[evento] || 'Reserva'

  const huesped = r?.guests?.[0]?.name || 'huésped'
  const fechas = r ? `${String(r.checkin || '').slice(0, 10)} → ${String(r.checkout || '').slice(0, 10)}` : ''
  const canal = r?.channelId || cuerpo?.channel || ''
  const texto = `🏨 ${etiqueta}${canal ? ` (${canal})` : ''}: ${huesped}${fechas ? ` · ${fechas}` : ''}${r?.refer ? ` · ${r.refer}` : ''}`

  await pool.query(
    'INSERT INTO notifications (id, account_id, type, title, body, created_at) VALUES (?,?,?,?,?,?)',
    [`ntf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, accId, 'pms_reservation', etiqueta, texto, Date.now()]
  ).catch(() => { /* la tabla puede no existir en instalaciones antiguas */ })

  socket.emit(accId, 'pms:reservation', { accId, evento, texto, reservation: r || { id } })
}

module.exports = { iniciarOauth, callbackOauth, reactivarAvisos, webhook, registrarAvisos, EVENTOS }
