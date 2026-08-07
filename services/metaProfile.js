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
 * @param {string} psid   PSID (Messenger) o IGSID (Instagram)
 * @param {string} token  Page Access Token del canal
 * @param {'messenger'|'instagram'} kind
 * @returns {Promise<{name:string, photo:string}|null>}
 */
async function fetchProfile(psid, token, kind = 'messenger') {
  if (!psid || !token) return null
  const hit = cache.get(psid)
  if (hit && Date.now() - hit.at < TTL) return hit.name || hit.photo ? hit : null

  // Instagram expone `name`/`username`; Messenger, `first_name`/`last_name`.
  const fields = kind === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic'
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(psid)}?fields=${fields}&access_token=${encodeURIComponent(token)}`)
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      // Lo más habitual: el usuario no ha iniciado la conversación todavía, o su perfil no es
      // accesible. No es motivo para tumbar el mensaje entrante, así que solo se anota.
      console.warn('[metaProfile]', kind, psid, d?.error?.message || `HTTP ${r.status}`)
      cache.set(psid, { name: '', photo: '', at: Date.now() })   // no reintentar en cada mensaje
      return null
    }
    const name = kind === 'instagram'
      ? (d.name || d.username || '')
      : [d.first_name, d.last_name].filter(Boolean).join(' ')
    const out = { name: String(name || '').trim(), photo: d.profile_pic || '', at: Date.now() }
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
async function probeProfile(psid, token, kind = 'messenger') {
  if (!psid) return { ok: false, error: 'No hay ninguna conversación de este canal todavía.' }
  if (!token) return { ok: false, error: 'El canal no tiene Page Access Token guardado.' }
  const fields = kind === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic'
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(psid)}?fields=${fields}&access_token=${encodeURIComponent(token)}`)
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      return { ok: false, error: d?.error?.message || `HTTP ${r.status}`, code: d?.error?.code, sub: d?.error?.error_subcode }
    }
    const name = kind === 'instagram'
      ? (d.name || d.username || '')
      : [d.first_name, d.last_name].filter(Boolean).join(' ')
    if (!name) return { ok: false, error: 'Meta respondió correctamente pero sin nombre (perfil restringido o normativa de privacidad de la región).' }
    return { ok: true, name }
  } catch (e) { return { ok: false, error: e.message } }
}

module.exports = { fetchProfile, probeProfile, isPlaceholder }
