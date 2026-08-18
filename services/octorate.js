'use strict'
/**
 * Cliente de la API de Octorate (PMS + channel manager + motor de reservas).
 *
 * Aquí vive lo de bajo nivel: OAuth2 y las llamadas HTTP. El adaptador que consume la
 * plataforma está en `pmsProviders.js`, que es quien traduce todo esto al contrato común
 * (getRooms, getAvailability, book…) para que el asistente no sepa qué PMS hay debajo.
 *
 * Dos diferencias con los otros PMS que conviene tener presentes:
 *
 *   · La autenticación es OAuth2 con código de autorización: el hotelero autoriza en el panel
 *     de Octorate y el token CADUCA. HosRoom y Kunas usan un token fijo que el cliente pega, así
 *     que aquí hay que renovar. Un token vale para UNA propiedad (o las de su red).
 *
 *   · La disponibilidad y el precio vienen juntos, del mismo endpoint que usa su motor de
 *     reservas (`/reservation/{acc}/search`). Eso simplifica mucho: una llamada da habitaciones,
 *     cupo, tarifas y todos los cargos.
 *
 * Documentación: https://api.octorate.com/connect/redocly.html
 */
const pool = require('../db')

const BASE = 'https://api.octorate.com/connect/rest/v1'
const AUTORIZAR = 'https://admin.octorate.com/octobook/identity/oauth.xhtml'
const TOKEN = `${BASE}/identity/token`
const REFRESCAR = `${BASE}/identity/refresh`

const TIMEOUT_MS = 20000

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function pedir(url, { method = 'GET', token, query, body, form } = {}) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, String(x)))
    else u.searchParams.set(k, String(v))
  }
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let cuerpo
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; cuerpo = new URLSearchParams(form).toString() }
  else if (body) { headers['Content-Type'] = 'application/json'; cuerpo = JSON.stringify(body) }

  const corte = new AbortController()
  const alarma = setTimeout(() => corte.abort(), TIMEOUT_MS)
  let res
  try {
    res = await fetch(u.toString(), { method, headers, body: cuerpo, signal: corte.signal })
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Octorate no respondió a tiempo.'), { status: 504 })
    throw Object.assign(new Error(`No se pudo contactar con Octorate: ${e.message}`), { status: 502 })
  } finally { clearTimeout(alarma) }

  const texto = await res.text()
  let datos = null
  try { datos = texto ? JSON.parse(texto) : null } catch { /* no era JSON */ }

  if (!res.ok) {
    // El mensaje se queda con el detalle de Octorate: sin él, un 400 no dice nada y la única
    // pista sería mirar los registros del servidor.
    const detalle = datos?.message || datos?.error_description || datos?.error || (texto || '').slice(0, 180)
    const err = new Error(`Octorate ${res.status}: ${detalle || 'error sin detalle'}`)
    err.status = res.status
    throw err
  }
  return datos
}

// ── OAuth2 ────────────────────────────────────────────────────────────────────

/** La URL a la que se manda al hotelero para que autorice. */
function urlDeAutorizacion({ clientId, redirectUri, state }) {
  const u = new URL(AUTORIZAR)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', 'any')
  if (state) u.searchParams.set('state', state)
  return u.toString()
}

/** Cambia el código de la vuelta por un par de tokens. */
async function canjearCodigo({ code, clientId, clientSecret, redirectUri }) {
  const d = await pedir(TOKEN, {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri },
  })
  return normalizarTokens(d)
}

async function refrescar({ refreshToken, clientId, clientSecret }) {
  const d = await pedir(REFRESCAR, {
    method: 'POST',
    form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret },
  })
  return normalizarTokens(d)
}

function normalizarTokens(d) {
  const acceso = d?.access_token || d?.accessToken || d?.token
  if (!acceso) throw new Error('Octorate no devolvió un token de acceso.')
  const segundos = Number(d?.expires_in || d?.expiresIn || 0) || 3600
  return {
    accessToken: acceso,
    refreshToken: d?.refresh_token || d?.refreshToken || null,
    // Se resta un minuto: si el token vence justo mientras viaja la petición, el cliente vería
    // un error por algo que sabíamos de antemano.
    expiraEn: Date.now() + (segundos - 60) * 1000,
  }
}

/**
 * Devuelve un token de acceso válido, renovándolo si hace falta y guardando el nuevo.
 *
 * La renovación se persiste porque el refresh token puede ser de un solo uso: si se renueva y
 * no se guarda, la siguiente renovación falla y el hotelero tendría que volver a autorizar.
 */
async function tokenValido(accId, cfg) {
  const t = cfg?.oauth || {}
  if (t.accessToken && Number(t.expiraEn) > Date.now()) return t.accessToken
  if (!t.refreshToken) {
    throw Object.assign(new Error('La conexión con Octorate expiró. Hay que volver a autorizarla desde Zona IA → PMS.'), { status: 401 })
  }
  // Las credenciales salen del superpanel (platform_settings), no del entorno: ver el
  // comentario en octorate.controller. Renovar con credenciales vacias devuelve un 401 que
  // parece un token caducado y manda a depurar al sitio equivocado.
  const [[cred]] = await pool.query(
    'SELECT octorate_client_id, octorate_client_secret FROM platform_settings WHERE id=1'
  ).catch(() => [[{}]])
  const clientId = cfg.clientId || cred?.octorate_client_id || process.env.OCTORATE_CLIENT_ID
  const clientSecret = cfg.clientSecret || cred?.octorate_client_secret || process.env.OCTORATE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error('Faltan las credenciales de Octorate en el superpanel → Integraciones.'), { status: 500 })
  }
  const nuevos = await refrescar({ refreshToken: t.refreshToken, clientId, clientSecret })
  await guardarTokens(accId, { ...nuevos, refreshToken: nuevos.refreshToken || t.refreshToken })
  return nuevos.accessToken
}

async function guardarTokens(accId, tokens) {
  const [[a]] = await pool.query('SELECT pms FROM accounts WHERE id=?', [accId])
  const cfg = (() => { try { return typeof a?.pms === 'string' ? JSON.parse(a.pms) : (a?.pms || {}) } catch { return {} } })()
  cfg.oauth = { ...(cfg.oauth || {}), ...tokens }
  await pool.query('UPDATE accounts SET pms=? WHERE id=?', [JSON.stringify(cfg), accId])
}

// ── Llamadas de la API ────────────────────────────────────────────────────────

/** Cualquier ruta de la API, ya con el token puesto y renovado si tocaba. */
async function api(accId, cfg, ruta, opciones = {}) {
  const token = await tokenValido(accId, cfg)
  return pedir(`${BASE}${ruta}`, { ...opciones, token })
}

// Propiedades
const listarPropiedades = (accId, cfg) => api(accId, cfg, '/accommodation')
const verPropiedad = (accId, cfg, acc) => api(accId, cfg, `/accommodation/${encodeURIComponent(acc)}`)
const fotosPropiedad = (accId, cfg, acc) => api(accId, cfg, `/accommodation/${encodeURIComponent(acc)}/photos`)

// Habitaciones
const verHabitacion = (accId, cfg, acc, roomId) =>
  api(accId, cfg, `/roomrates/${encodeURIComponent(acc)}/${encodeURIComponent(roomId)}`)

/**
 * El buscador del motor de reservas: en UNA llamada da habitaciones, cupo, tarifas y cargos.
 * Es la pieza central de la integración — sirve para listar habitaciones, para cotizar y para
 * revalidar justo antes de reservar.
 */
const buscar = (accId, cfg, acc, { checkin, checkout, adults, children, currency, availcheck = true, ids } = {}) =>
  api(accId, cfg, `/reservation/${encodeURIComponent(acc)}/search`, {
    query: { checkin, checkout, adults, children, currency, availcheck, 'ids[]': ids },
  })

// Reservas
const crearReserva = (accId, cfg, acc, cuerpo) =>
  api(accId, cfg, `/reservation/${encodeURIComponent(acc)}`, { method: 'POST', body: cuerpo })
const verReserva = (accId, cfg, acc, id) =>
  api(accId, cfg, `/reservation/${encodeURIComponent(acc)}/${encodeURIComponent(id)}`)
const modificarReserva = (accId, cfg, acc, id, cuerpo) =>
  api(accId, cfg, `/reservation/${encodeURIComponent(acc)}/${encodeURIComponent(id)}`, { method: 'PATCH', body: cuerpo })
const borrarReserva = (accId, cfg, acc, id) =>
  api(accId, cfg, `/reservation/${encodeURIComponent(acc)}/${encodeURIComponent(id)}`, { method: 'DELETE' })

// Mensajería con los portales (Airbnb, Booking…)
const listarHilos = (accId, cfg, prop, query) =>
  api(accId, cfg, `/chat/${encodeURIComponent(prop)}/threads`, { query })
const mensajesDelHilo = (accId, cfg, prop, hilo, query) =>
  api(accId, cfg, `/chat/${encodeURIComponent(prop)}/threads/${encodeURIComponent(hilo)}/messages`, { query })
const enviarMensaje = (accId, cfg, prop, cuerpo) =>
  api(accId, cfg, `/chat/${encodeURIComponent(prop)}/messages`, { method: 'POST', body: cuerpo })

// Avisos automáticos (webhooks)
const suscribir = (accId, cfg, evento, url) =>
  api(accId, cfg, `/subscription/${encodeURIComponent(evento)}`, { method: 'POST', query: { url }, body: { url } })
const listarSuscripciones = (accId, cfg) => api(accId, cfg, '/subscription/list')

module.exports = {
  BASE, urlDeAutorizacion, canjearCodigo, refrescar, tokenValido, guardarTokens, api, pedir,
  listarPropiedades, verPropiedad, fotosPropiedad, verHabitacion, buscar,
  crearReserva, verReserva, modificarReserva, borrarReserva,
  listarHilos, mensajesDelHilo, enviarMensaje,
  suscribir, listarSuscripciones,
}
