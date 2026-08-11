'use strict'
/**
 * Apariencia del widget de webchat y comprobación de dominio.
 *
 * El fragmento que pega el cliente en su web lleva SOLO los identificadores; el color, la
 * posición y los textos los pide widget.js aquí. Así, cambiar el color en el panel se ve al
 * instante en la web del cliente sin que tenga que volver a pegar nada — que es la
 * diferencia entre una función que se usa y una que nadie actualiza nunca.
 *
 * Lo que se devuelve es una lista CERRADA de campos. La configuración del canal es un objeto
 * libre donde también viven credenciales de otros canales, así que aquí nunca se reenvía
 * entera: se copia campo a campo.
 */

const pool = require('../db')
const { parseJ } = require('../utils')

// Lo único que el widget necesita saber. Cualquier otra cosa del canal se queda en casa.
const APARIENCIA = {
  color: '#7c6fff',
  position: 'right',
  title: 'Chat',
  buttonText: '',
  avatar: '',
  teaser: '',
  autoOpen: false,
  autoOpenDelay: 5,
}

/** Los dominios autorizados, normalizados: sin protocolo, sin ruta, sin www y en minúsculas. */
function normalizarDominios(lista) {
  if (!Array.isArray(lista)) return []
  return lista
    .map(d => String(d || '').toLowerCase().trim()
      .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, ''))
    .filter(Boolean)
}

/**
 * ¿Este dominio puede usar el canal?
 *
 * Vacío = cualquiera, para no dejar mudos los canales que ya funcionan.
 *
 * Un dominio autorizado vale también para sus subdominios, pero comparando por el FINAL con
 * un punto delante: mirar si el nombre «contiene» el dominio dejaría pasar
 * `midominio.com.atacante.com`, que es justo lo que hay que impedir.
 */
function dominioPermitido(hostname, permitidos) {
  const lista = normalizarDominios(permitidos)
  if (!lista.length) return true
  const h = String(hostname || '').toLowerCase().trim().replace(/:\d+$/, '').replace(/^www\./, '')
  if (!h) return false
  return lista.some(d => h === d || h.endsWith('.' + d))
}

/** El nombre de host de una cabecera Origin o Referer. */
function hostDe(cabecera) {
  if (!cabecera) return ''
  try { return new URL(cabecera).hostname } catch { return '' }
}

/** Busca un canal de webchat concreto dentro de un agente. */
async function buscarCanal(accId, agId, chId) {
  const [[ag]] = await pool.query('SELECT channels FROM agents WHERE id=? AND account_id=?', [agId, accId])
  if (!ag) return null
  const canales = parseJ(ag.channels, [])
  return canales.find(c => c.id === chId && ['webchat', 'test'].includes(c.type)) || null
}

// GET /api/public/webchat/:accId/:agId/:chId/widget   (sin autenticación: lo llama la web del cliente)
const widgetConfig = async (req, res) => {
  const { accId, agId, chId } = req.params
  try {
    const canal = await buscarCanal(accId, agId, chId)
    if (!canal) return res.status(404).json({ error: 'Canal no encontrado' })
    const cfg = canal.config || {}

    const out = {}
    for (const [clave, porDefecto] of Object.entries(APARIENCIA)) {
      out[clave] = cfg[clave] != null && cfg[clave] !== '' ? cfg[clave] : porDefecto
    }
    // La lista se envía para que el widget ni se pinte donde no debe. No es un secreto: son
    // los dominios del propio cliente, y quien mire el código de su web ya los conoce.
    out.allowedDomains = normalizarDominios(cfg.allowedDomains)
    // Si la petición trae origen y NO está autorizado, se dice explícitamente: así el
    // widget puede callarse aunque alguien haya trucado la lista en su copia del script.
    const host = hostDe(req.headers.origin) || hostDe(req.headers.referer)
    out.allowed = host ? dominioPermitido(host, out.allowedDomains) : true

    // Cacheable un ratito: el widget lo pide en cada carga de página de la web del cliente,
    // y esto cambia como mucho unas pocas veces al año.
    res.set('Cache-Control', 'public, max-age=300')
    res.json(out)
  } catch (err) {
    console.error('[widgetConfig]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = { widgetConfig, dominioPermitido, normalizarDominios, hostDe, buscarCanal, APARIENCIA }
