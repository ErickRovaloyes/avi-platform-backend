'use strict'
/**
 * Base de adaptadores de canal/OTA. Cada proveedor (airbnb/booking/hosroom/kunas)
 * implementa esta interfaz. La idea: el adaptador trae TODO (habitaciones con
 * fotos/descripción/amenidades, disponibilidad, tarifas y reservas) y normaliza al
 * modelo de AVI. Para conectarlo en el futuro SOLO hay que rellenar las credenciales
 * que declara `credentialFields()` — el resto ya está cableado.
 *
 * Formas normalizadas:
 *   RoomType  { externalId, name, description, capacity, maxCapacity, totalRooms,
 *               basePrice, currency, amenities:[], photos:[url] }
 *   Reservation { ref, externalRoomId, checkin, checkout, guests, guestName,
 *                 guestPhone, guestEmail, total, currency, status }
 *   AvailabilityItem { externalRoomId, date, available, price }
 *
 * Métodos (todos opcionales salvo credentialFields; si un proveedor no soporta uno,
 * lanza o devuelve []):
 *   credentialFields() -> [{ key, label, type, required, help }]
 *   testConnection(config) -> { ok, message }
 *   importRoomTypes(config) -> RoomType[]
 *   importReservations(config, { from, to }) -> Reservation[]
 *   importAvailability(config, { from, to }) -> AvailabilityItem[]
 *   pushAvailability(config, { externalRoomId, updates:[{date, available, price}] }) -> { ok }
 *   pushRates(config, { externalRoomId, rates:[{date, price}] }) -> { ok }
 */

// fetch JSON con auth flexible. Lanza con el cuerpo del error para diagnóstico.
async function httpJson(url, { method = 'GET', headers = {}, body, auth } = {}) {
  const h = { 'Accept': 'application/json', ...headers }
  if (auth?.bearer) h['Authorization'] = `Bearer ${auth.bearer}`
  if (auth?.basic) h['Authorization'] = 'Basic ' + Buffer.from(`${auth.basic.user}:${auth.basic.pass}`).toString('base64')
  if (auth?.apiKeyHeader && auth?.apiKey) h[auth.apiKeyHeader] = auth.apiKey
  if (body && !h['Content-Type']) h['Content-Type'] = 'application/json'
  const res = await fetch(url, { method, headers: h, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined })
  const text = await res.text()
  let data = null; try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data?.error || data || {}).slice(0, 200)}`)
  return data
}

// Devuelve el valor por un "path" tipo 'a.b.0.c' (para mapear respuestas flexibles).
function pick(obj, path, def) {
  if (!path) return def
  try { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj) ?? def } catch { return def }
}

// Interfaz por defecto (cada método no soportado se reporta claramente).
const notSupported = (name, provider) => () => { throw new Error(`${provider}: ${name} no implementado para este proveedor`) }

function defineAdapter(def) {
  return {
    id: def.id,
    credentialFields: def.credentialFields || (() => []),
    testConnection: def.testConnection || (async () => ({ ok: false, message: 'Sin prueba de conexión' })),
    importRoomTypes: def.importRoomTypes || (async () => []),
    importReservations: def.importReservations || (async () => []),
    importAvailability: def.importAvailability || (async () => []),
    pushAvailability: def.pushAvailability || notSupported('pushAvailability', def.id),
    pushRates: def.pushRates || notSupported('pushRates', def.id),
    requires: def.requires || [], // claves de config obligatorias para operar por API
  }
}

function hasCreds(config, keys) { return keys.every(k => config?.[k]) }

module.exports = { httpJson, pick, defineAdapter, hasCreds }
