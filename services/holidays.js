'use strict'
/**
 * Días festivos por país — usa la API pública Nager.Date (sin API key) y cachea
 * en memoria por país+año. Si falla la red, devuelve vacío (no bloquea nada).
 *   https://date.nager.at/api/v3/PublicHolidays/{year}/{COUNTRY}
 * COUNTRY = código ISO 3166-1 alpha-2 (PE, CO, MX, AR, CL, US, ES, ...).
 */

const cache = new Map() // `${country}_${year}` -> { set, list, exp }
const TTL = 7 * 24 * 3600 * 1000

async function fetchHolidays(country, year) {
  if (!country) return { set: new Set(), list: [] }
  const key = `${country}_${year}`
  const c = cache.get(key)
  if (c && c.exp > Date.now()) return c
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(country)}`)
    if (!res.ok) { const empty = { set: new Set(), list: [], exp: Date.now() + 3600000 }; cache.set(key, empty); return empty }
    const data = await res.json()
    const list = (Array.isArray(data) ? data : []).map(h => ({ date: h.date, name: h.localName || h.name }))
    const entry = { set: new Set(list.map(h => h.date)), list, exp: Date.now() + TTL }
    cache.set(key, entry)
    return entry
  } catch {
    const empty = { set: new Set(), list: [], exp: Date.now() + 600000 }
    cache.set(key, empty)
    return empty
  }
}

async function getHolidayList(country, year) { return (await fetchHolidays(country, year)).list }
async function getHolidaySet(country, year)  { return (await fetchHolidays(country, year)).set }
async function isHoliday(country, dateStr) {
  if (!country || !dateStr) return false
  const set = await getHolidaySet(country, dateStr.slice(0, 4))
  return set.has(dateStr)
}

module.exports = { getHolidayList, getHolidaySet, isHoliday }
