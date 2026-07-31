'use strict'
/**
 * Tasa de cambio COP↔USD en tiempo real para mostrar el precio en dólares de los
 * planes (la moneda BASE es el peso colombiano). Usa una API pública gratuita, con
 * cache en memoria + respaldo en platform_settings.fx_usd_cop (última tasa conocida)
 * para no depender de la red en cada consulta ni romperse si la API cae.
 *
 * fx_usd_cop = cuántos COP vale 1 USD (p. ej. 4000).
 */
const pool = require('../db')

const REFRESH_MS = 12 * 60 * 60 * 1000   // refresca como máximo cada 12 h
const FALLBACK_RATE = 4000               // respaldo si nunca se ha podido consultar
const MIN_RATE = 1000, MAX_RATE = 20000  // cordura (evita tasas absurdas de una API rota)

let _cache = { rate: 0, at: 0 }

// Consulta la tasa USD→COP a una API pública. Devuelve un número o null.
async function fetchRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout?.(8000) })
    if (!res.ok) return null
    const j = await res.json().catch(() => null)
    const rate = Number(j?.rates?.COP)
    if (rate && rate >= MIN_RATE && rate <= MAX_RATE) return rate
  } catch { /* red/timeout */ }
  return null
}

async function loadStored() {
  try {
    const [[r]] = await pool.query('SELECT fx_usd_cop, fx_updated_at FROM platform_settings WHERE id=1')
    const rate = Number(r?.fx_usd_cop)
    if (rate && rate >= MIN_RATE && rate <= MAX_RATE) return { rate, at: Number(r?.fx_updated_at) || 0 }
  } catch { /* columna aún no migrada */ }
  return null
}

async function storeRate(rate) {
  try { await pool.query('UPDATE platform_settings SET fx_usd_cop=?, fx_updated_at=? WHERE id=1', [rate, Date.now()]) }
  catch { /* no crítico */ }
}

// Devuelve { rate, updatedAt, stale }. rate = COP por 1 USD. Refresca si toca; si la
// API falla, usa el último valor guardado (o el respaldo).
async function getRate() {
  const now = Date.now()
  if (_cache.rate && now - _cache.at < REFRESH_MS) return { rate: _cache.rate, updatedAt: _cache.at, stale: false }
  // Cache en frío → intenta cargar el último valor guardado primero.
  if (!_cache.rate) { const st = await loadStored(); if (st) _cache = { rate: st.rate, at: st.at } }
  // ¿Toca refrescar contra la API?
  if (!_cache.rate || now - _cache.at >= REFRESH_MS) {
    const fresh = await fetchRate()
    if (fresh) { _cache = { rate: fresh, at: now }; await storeRate(fresh) }
  }
  const rate = _cache.rate || FALLBACK_RATE
  return { rate, updatedAt: _cache.at || 0, stale: !_cache.rate }
}

// Convierte COP → USD con la tasa viva. Redondea a 2 decimales.
async function copToUsd(cop) {
  const { rate } = await getRate()
  const amount = Number(cop) || 0
  if (!rate) return 0
  return Math.round((amount / rate) * 100) / 100
}

module.exports = { getRate, copToUsd, FALLBACK_RATE }
