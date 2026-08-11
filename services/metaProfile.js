'use strict'
/**
 * Perfil público de quien escribe por Messenger / Instagram.
 *
 * El webhook de Meta NO manda el nombre: solo el PSID (Messenger) o el IGSID (Instagram).
 * Por eso las conversaciones aparecían como "FB #5326", que no dice con quién hablas.
 * El nombre hay que PEDIRLO a la API de perfil con el token de la página.
 *
 * Requiere `pages_messaging`, que ya se concede al conectar el canal, y solo funciona con
 * usuarios que han escrito a la página — que es exactamente nuestro caso.
 *
 * Meta puede no devolver nombre (perfiles restringidos o normativa de privacidad de la
 * región). Eso no es un error: se deja el marcador y la conversación sigue funcionando.
 */
const GRAPH = 'https://graph.facebook.com/v19.0'

// Caché en memoria: el mismo contacto escribe muchas veces y el nombre no cambia entre
// mensajes. Evita una llamada a Meta por cada mensaje entrante.
const cache = new Map()          // psid → { name, photo, at }
const TTL = 6 * 60 * 60 * 1000   // 6 h

// Nombres que NO son un nombre: los marcadores que genera la plataforma cuando no lo sabe.
//
// El límite de palabra (\b) no es un detalle: sin él, "Guestavo Ríos" o "Visitantes SA"
// pasarían por marcadores y sus nombres reales acabarían sobrescritos.
const PLACEHOLDER_RE = /^(?:(?:Visitante|Guest)\b|(?:WA|FB|IG) #)/i
function isPlaceholder(name) {
  return !name || !String(name).trim() || PLACEHOLDER_RE.test(String(name).trim())
}

/**
 * Nombres a partir de las CONVERSACIONES de la página.
 *
 * Es la segunda vía, y en muchas apps la única que funciona: pedir el perfil por el
 * identificador del usuario (`/{PSID}`) devuelve error 100 aunque el token sea el correcto y
 * el permiso esté aprobado. La lista de conversaciones de la página sí incluye el nombre de
 * cada participante, y usa los mismos permisos que ya tiene el canal.
 *
 * Se piden varias de una vez y se cachean todas: quien escribe suele estar entre las
 * conversaciones recientes, así que una llamada resuelve muchos nombres.
 */
async function fetchFromConversations(pageId, token, kind = 'messenger') {
  if (!pageId || !token) return 0
  const plataforma = kind === 'instagram' ? '&platform=instagram' : ''
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/conversations?fields=participants&limit=100${plataforma}&access_token=${encodeURIComponent(token)}`)
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { console.warn('[metaProfile conversations]', d?.error?.message || `HTTP ${r.status}`); return 0 }
    let n = 0
    for (const conv of (d.data || [])) {
      for (const p of (conv.participants?.data || [])) {
        // El propio negocio también figura como participante: se ignora.
        if (!p?.id || String(p.id) === String(pageId)) continue
        const nombre = String(p.name || p.username || '').trim()
        if (!nombre) continue
        cache.set(String(p.id), { name: nombre, photo: '', at: Date.now() })
        n++
      }
    }
    return n
  } catch (e) { console.warn('[metaProfile conversations]', e.message); return 0 }
}

/**
 * @param {string} psid   PSID (Messenger) o IGSID (Instagram)
 * @param {string} token  Page Access Token del canal
 * @param {'messenger'|'instagram'} kind
 * @param {string} pageId Página del canal (para la vía de conversaciones)
 * @returns {Promise<{name:string, photo:string}|null>}
 */
async function fetchProfile(psid, token, kind = 'messenger', pageId = '') {
  if (!psid || !token) return null
  const hit = cache.get(psid)
  if (hit && Date.now() - hit.at < TTL) return hit.name || hit.photo ? hit : null

  // Instagram expone `name`/`username`; Messenger, `first_name`/`last_name`.
  const fields = kind === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic'
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(psid)}?fields=${fields}&access_token=${encodeURIComponent(token)}`)
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      // Vía directa rechazada (error 100 típico, aun con token y permisos correctos).
      // Se intenta por las conversaciones de la página antes de rendirse.
      console.warn('[metaProfile]', kind, psid, d?.error?.message || `HTTP ${r.status}`)
      if (pageId) {
        const n = await fetchFromConversations(pageId, token, kind)
        const hit2 = cache.get(psid)
        if (hit2?.name) { console.log(`[metaProfile] nombre resuelto por conversaciones (${n} cacheados)`); return hit2 }
      }
      cache.set(psid, { name: '', photo: '', at: Date.now() })   // no reintentar en cada mensaje
      return null
    }
    const name = kind === 'instagram'
      ? (d.name || d.username || '')
      : [d.first_name, d.last_name].filter(Boolean).join(' ')
    const out = { name: String(name || '').trim(), username: d.username || '', photo: d.profile_pic || '', at: Date.now() }
    cache.set(psid, out)
    return out.name || out.photo ? out : null
  } catch (e) {
    console.warn('[metaProfile]', kind, e.message)
    return null
  }
}

/**
 * Igual que fetchProfile pero SIN caché y devolviendo el motivo exacto de Meta.
 * Es para diagnóstico: cuando el nombre no aparece, `fetchProfile` devuelve null y el
 * porqué se queda en el log del servidor, donde nadie puede verlo.
 */
async function probeProfile(psid, token, kind = 'messenger', pageId = '') {
  if (!psid) return { ok: false, error: 'No hay ninguna conversación de este canal todavía.' }
  if (!token) return { ok: false, error: 'El canal no tiene Page Access Token guardado.' }
  const fields = kind === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic'
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(psid)}?fields=${fields}&access_token=${encodeURIComponent(token)}`)
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      // Vía directa rechazada: se prueba la de conversaciones, que es la que suele funcionar.
      if (pageId) {
        const n = await fetchFromConversations(pageId, token, kind)
        const hit = cache.get(String(psid))
        if (hit?.name) return { ok: true, name: hit.name, via: 'conversaciones', cacheados: n }
        return { ok: false, error: (d?.error?.message || `HTTP ${r.status}`) + ` · La vía de conversaciones tampoco lo encontró (${n} nombres leídos).`, code: d?.error?.code }
      }
      return { ok: false, error: d?.error?.message || `HTTP ${r.status}`, code: d?.error?.code, sub: d?.error?.error_subcode }
    }
    const name = kind === 'instagram'
      ? (d.name || d.username || '')
      : [d.first_name, d.last_name].filter(Boolean).join(' ')
    if (!name) return { ok: false, error: 'Meta respondió correctamente pero sin nombre (perfil restringido o normativa de privacidad de la región).' }
    return { ok: true, name }
  } catch (e) { return { ok: false, error: e.message } }
}

/**
 * Perfil de quien escribe cuando la cuenta se conectó con el INICIO NATIVO de Instagram.
 *
 * Es otra API (graph.instagram.com) y otro token: el de la Página no sirve, porque en ese modo
 * la cuenta no cuelga de ninguna Página. A cambio es más directo que la vía por Página, que
 * necesita el rodeo por la lista de conversaciones.
 */
async function fetchInstagramNative(igsid, token) {
  if (!igsid || !token) return null
  const hit = cache.get(igsid)
  if (hit && Date.now() - hit.at < TTL) return hit.name || hit.photo ? hit : null
  try {
    const r = await fetch(`https://graph.instagram.com/${encodeURIComponent(igsid)}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`)
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      console.warn('[metaProfile instagram nativo]', igsid, d?.error?.message || `HTTP ${r.status}`)
      cache.set(igsid, { name: '', photo: '', at: Date.now() })   // no reintentar en cada mensaje
      return null
    }
    // El nombre de usuario se guarda APARTE del nombre: es lo único con lo que se puede
    // componer el enlace al perfil (instagram.com/usuario), y hasta ahora se perdía al
    // quedarse solo con uno de los dos.
    const out = { name: String(d.name || d.username || '').trim(), username: d.username || '', photo: d.profile_pic || '', at: Date.now() }
    cache.set(igsid, out)
    return out.name || out.photo ? out : null
  } catch (e) { console.warn('[metaProfile instagram nativo]', e.message); return null }
}

module.exports = { fetchProfile, probeProfile, fetchFromConversations, isPlaceholder, fetchInstagramNative }
