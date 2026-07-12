'use strict'
// ── Geolocalización de zonas de entrega ────────────────────────────────────────
// Convierte una dirección en coordenadas (geocodificación) y determina, mediante
// point-in-polygon, si cae dentro de alguna zona de cobertura dibujada en el mapa.
//
// Geocodificador CONFIGURABLE por cuenta (en la config de Pedidos):
//   · Por defecto: Nominatim (OpenStreetMap) — gratis, sin API key.
//   · Opcional: Google Geocoding, si el negocio pega su API key (más preciso).
const pool = require('../db')
const { parseJ } = require('../utils')

// Ray-casting: ¿el punto (lat,lng) está dentro del anillo [[lat,lng], …]?
// Tratamos lng como X y lat como Y; el algoritmo es indiferente a la proyección
// para polígonos pequeños (zonas de reparto urbanas).
function pointInRing(lat, lng, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1]
    const yj = ring[j][0], xj = ring[j][1]
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

// polygon = anillo simple [[lat,lng], …] o multi-anillo [[[lat,lng],…], …].
function pointInPolygon(lat, lng, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    // Multi-anillo: primer elemento es a su vez un anillo de pares.
    if (Array.isArray(polygon) && Array.isArray(polygon[0]) && Array.isArray(polygon[0][0])) {
      return polygon.some(r => Array.isArray(r) && r.length >= 3 && pointInRing(lat, lng, r))
    }
    return false
  }
  // ¿anillo simple (pares [lat,lng]) o multi-anillo?
  if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0])) {
    return polygon.some(r => Array.isArray(r) && r.length >= 3 && pointInRing(lat, lng, r))
  }
  return pointInRing(lat, lng, polygon)
}

// dirección → { lat, lng, provider, formatted } | null
async function geocode(address, { googleKey, country } = {}) {
  const q = String(address || '').trim()
  if (!q) return null
  try {
    if (googleKey) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}` +
        (country ? `&region=${encodeURIComponent(country)}` : '') + `&key=${encodeURIComponent(googleKey)}`
      const r = await fetch(url)
      const j = await r.json()
      const hit = j?.results?.[0]
      if (hit?.geometry?.location) {
        return { lat: Number(hit.geometry.location.lat), lng: Number(hit.geometry.location.lng), provider: 'google', formatted: hit.formatted_address || q }
      }
      return null
    }
    // Nominatim exige un User-Agent identificable y limita ~1 req/seg.
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}` +
      (country ? `&countrycodes=${encodeURIComponent(country)}` : '')
    const r = await fetch(url, { headers: { 'User-Agent': 'AVI-Platform/1.0 (delivery-zones)', 'Accept-Language': 'es' } })
    if (!r.ok) return null
    const j = await r.json()
    const hit = Array.isArray(j) && j[0]
    if (hit) return { lat: Number(hit.lat), lng: Number(hit.lon), provider: 'nominatim', formatted: hit.display_name || q }
    return null
  } catch (e) { console.error('[geocode]', e?.message || e); return null }
}

const mapZoneRow = z => ({
  id: z.id, name: z.name, fee: Number(z.fee) || 0, minOrder: Number(z.min_order) || 0,
  etaMin: z.eta_min || 0, city: z.city || '', color: z.color || '', extraInfo: z.extra_info || '',
  active: z.active == null ? true : !!z.active,
})

// Geocodifica la dirección y busca la primera zona ACTIVA con polígono que la
// contenga. Devuelve { geo, zone, matched }. Si no hay geocodificación posible
// (dirección vaga o servicio caído) → geo:null para que el llamador use el
// fallback por nombre de zona.
async function resolveDeliveryZone(accId, address, cfg = {}) {
  const geo = await geocode(address, { googleKey: cfg.geoGoogleKey, country: cfg.geoCountry })
  if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) return { geo: null, zone: null, matched: false }
  let rows = []
  try { [rows] = await pool.query('SELECT * FROM order_zones WHERE account_id=? ORDER BY sort, name', [accId]) } catch { return { geo, zone: null, matched: false } }
  for (const z of rows) {
    if (z.active === 0) continue
    const poly = parseJ(z.polygon, null)
    if (Array.isArray(poly) && poly.length >= 3 && pointInPolygon(geo.lat, geo.lng, poly)) {
      return { geo, zone: mapZoneRow(z), matched: true }
    }
  }
  return { geo, zone: null, matched: false }
}

module.exports = { geocode, pointInPolygon, resolveDeliveryZone, mapZoneRow }
