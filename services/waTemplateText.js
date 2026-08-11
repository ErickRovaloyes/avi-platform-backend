'use strict'
/**
 * El TEXTO REAL de una plantilla de WhatsApp, para dejarlo en la bandeja.
 *
 * Hasta ahora, al enviar una plantilla en el historial quedaba su nombre técnico
 * («recordatorio_cita_v3»). Quien atiende el chat veía un identificador que no dice nada:
 * no sabía qué le había llegado al cliente, y respondía a ciegas a un mensaje que no podía
 * leer. Aquí se reconstruye lo que el cliente recibió de verdad.
 *
 * Meta guarda la plantilla por un lado (con huecos {{1}}, {{2}}…) y nosotros mandamos los
 * valores por otro. Ninguna de las dos mitades sirve sola, así que hay que juntarlas.
 *
 * Regla que vale para todo el archivo: **esto no puede tumbar un envío**. Cuando se llama,
 * el mensaje YA salió hacia el cliente; si Meta no contesta o la plantilla no aparece, se
 * devuelve un texto de respaldo con el nombre. Peor que ver el nombre es que el mensaje no
 * aparezca en la conversación.
 */

const { listWhatsAppTemplates } = require('./metaSend')

// Las plantillas cambian poco (Meta debe aprobar cada cambio) y se envían en ráfagas
// —recordatorios, recuperación de carritos—, así que sin caché haríamos una llamada por
// mensaje para leer siempre lo mismo.
const TTL = 10 * 60 * 1000
const cache = new Map()   // businessAccountId → { at, lista }

async function fetchTemplates(businessAccountId, accessToken) {
  const hit = cache.get(businessAccountId)
  if (hit && Date.now() - hit.at < TTL) return hit.lista
  const lista = await listWhatsAppTemplates({ businessAccountId, accessToken })
  cache.set(businessAccountId, { at: Date.now(), lista })
  return lista
}

// Tras crear o editar una plantilla, la copia guardada ya no vale.
function invalidate(businessAccountId) {
  if (businessAccountId) cache.delete(businessAccountId)
  else cache.clear()
}

/**
 * El valor visible de un parámetro enviado.
 *
 * Un parámetro no siempre es texto: `currency` y `date_time` viajan como objeto y traen un
 * `fallback_value` que es, precisamente, lo que WhatsApp acaba mostrando.
 */
function valorParam(p) {
  if (p == null) return ''
  if (typeof p === 'string') return p
  if (p.text != null) return String(p.text)
  if (p.currency?.fallback_value) return String(p.currency.fallback_value)
  if (p.date_time?.fallback_value) return String(p.date_time.fallback_value)
  if (p.image) return '🖼 imagen'
  if (p.video) return '🎬 vídeo'
  if (p.document) return `📎 ${p.document.filename || 'documento'}`
  return ''
}

/**
 * Sustituye los huecos de un texto de plantilla por los valores enviados.
 *
 * Meta admite dos formas de nombrar los huecos y una plantilla usa una u otra:
 *   · por posición — {{1}}, {{2}}…
 *   · por nombre   — {{nombre_cliente}}, que viaja con `parameter_name` en el parámetro.
 *
 * Un hueco sin valor se deja tal cual en lugar de vaciarlo: así se ve que falta un dato,
 * que es justo lo que hay que notar al revisar por qué un mensaje salió raro.
 */
function rellenar(texto, params) {
  if (!texto) return ''
  const lista = Array.isArray(params) ? params : []
  const porNombre = new Map()
  for (const p of lista) if (p?.parameter_name) porNombre.set(String(p.parameter_name), valorParam(p))

  return String(texto).replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (todo, clave) => {
    if (/^\d+$/.test(clave)) {
      const v = valorParam(lista[Number(clave) - 1])
      return v !== '' ? v : todo
    }
    const v = porNombre.get(clave)
    return v != null && v !== '' ? v : todo
  })
}

// Los parámetros que se enviaron para una sección concreta (header / body / button).
function paramsDe(componentes, tipo, index) {
  const lista = Array.isArray(componentes) ? componentes : []
  const c = lista.find(x => {
    if (String(x?.type || '').toLowerCase() !== tipo) return false
    if (index == null) return true
    return String(x?.index ?? '0') === String(index)
  })
  return c?.parameters || []
}

/**
 * Junta la plantilla aprobada con los valores enviados y devuelve lo que leyó el cliente.
 *
 * Se reconstruye el mensaje entero —cabecera, cuerpo, pie y botones—, no solo el cuerpo:
 * una plantilla cuya única llamada a la acción está en un botón («Ver mi pedido», con su
 * enlace) se leería vacía si solo mirásemos el cuerpo.
 *
 * @param tpl         la plantilla tal como la devuelve Meta (con sus `components`)
 * @param componentes los componentes que se enviaron, con los valores de los huecos
 */
function renderTemplate(tpl, componentes) {
  const partes = []
  const secciones = tpl?.components || []

  for (const sec of secciones) {
    const tipo = String(sec?.type || '').toUpperCase()

    if (tipo === 'HEADER') {
      const formato = String(sec.format || 'TEXT').toUpperCase()
      if (formato === 'TEXT' && sec.text) {
        partes.push(rellenar(sec.text, paramsDe(componentes, 'header')))
      } else if (formato !== 'TEXT') {
        // Cabecera de medios: el archivo va en el envío, no en la plantilla. Se marca su
        // presencia para que no parezca que el cliente recibió solo texto.
        const icono = { IMAGE: '🖼 Imagen', VIDEO: '🎬 Vídeo', DOCUMENT: '📎 Documento', LOCATION: '📍 Ubicación' }[formato]
        if (icono) partes.push(icono)
      }
    } else if (tipo === 'BODY' && sec.text) {
      partes.push(rellenar(sec.text, paramsDe(componentes, 'body')))
    } else if (tipo === 'FOOTER' && sec.text) {
      partes.push(sec.text)
    } else if (tipo === 'BUTTONS') {
      const botones = (sec.buttons || []).map((b, i) => {
        const etiqueta = b?.text || 'Botón'
        // Solo los botones de URL dinámica llevan hueco; el resto es fijo.
        const url = b?.url ? rellenar(b.url, paramsDe(componentes, 'button', i)) : ''
        return url ? `[ ${etiqueta} ] ${url}` : `[ ${etiqueta} ]`
      })
      if (botones.length) partes.push(botones.join('\n'))
    }
  }

  return partes.filter(Boolean).join('\n\n').trim()
}

// Cuando no hay forma de leer la plantilla, al menos que se sepa qué se mandó.
function respaldo(nombre) {
  return `📋 Plantilla enviada${nombre ? `: ${nombre}` : ''}`
}

/**
 * Texto de la plantilla que se acaba de enviar, listo para guardar en la conversación.
 *
 * Nunca lanza: si algo falla devuelve el respaldo con el nombre. Se llama cuando el mensaje
 * ya salió, y un fallo aquí no debe impedir que quede registrado en la bandeja.
 */
async function templateText({ businessAccountId, accessToken, name, language, components }) {
  const nombre = String(name || '').trim()
  if (!nombre) return respaldo('')
  if (!businessAccountId || !accessToken) return respaldo(nombre)
  try {
    const todas = await fetchTemplates(businessAccountId, accessToken)
    // El nombre se repite entre idiomas: la misma plantilla en es y en en son dos entradas.
    // Si no está el idioma pedido se toma la del mismo nombre, que dice lo mismo en otro
    // idioma — más útil que no enseñar nada.
    const mismas = todas.filter(t => t.name === nombre)
    const tpl = mismas.find(t => t.language === language) || mismas[0]
    if (!tpl) return respaldo(nombre)
    const texto = renderTemplate(tpl, components)
    return texto || respaldo(nombre)
  } catch (e) {
    console.warn('[waTemplateText]', e.message)
    return respaldo(nombre)
  }
}

module.exports = { templateText, renderTemplate, rellenar, invalidate, respaldo }
