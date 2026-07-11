'use strict'
// Copiloto de negocio: el dueño pregunta y la IA responde con base en los datos del CRM.
// Reúne un "contexto" compacto de métricas y lo pasa al Modelo IA de Negocio (Super Panel).
const pool = require('../db')
const { callAI, detectProvider, resolveProviderKey } = require('../controllers/promptGenerator.controller')
const { buildSummary } = require('./execSummary')

const DAY = 86400000
const money = (n, c) => `${Math.round(Number(n) || 0).toLocaleString('es-CO')} ${c || ''}`.trim()
const fmtDur = ms => { if (ms == null) return 'n/d'; const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m` }

async function businessModel() {
  try { const [[ps]] = await pool.query('SELECT business_ai_model FROM platform_settings WHERE id=1'); return ps?.business_ai_model || 'gpt-4o-mini' }
  catch { return 'gpt-4o-mini' }
}

// Contexto de negocio en texto legible (barato y fácil para el LLM).
async function buildContext(accId, days = 30) {
  const sm = await buildSummary(accId, days)
  const now = Date.now()

  // Retención (recencia de compra) + top clientes + clientes en riesgo.
  let retention = { active: 0, atRisk: 0, inactive: 0, churned: 0 }, topCustomers = [], atRisk = []
  try {
    const [rows] = await pool.query(
      "SELECT o.contact_id, c.name, MAX(o.created_at) AS lastAt, COUNT(*) AS n, COALESCE(SUM(o.total),0) AS spend FROM orders o LEFT JOIN contacts c ON c.id=o.contact_id WHERE o.account_id=? AND o.contact_id IS NOT NULL AND o.status NOT IN('draft','canceled') GROUP BY o.contact_id",
      [accId])
    for (const r of rows) {
      const d = (now - Number(r.lastAt)) / DAY
      if (d <= 30) retention.active++; else if (d <= 60) retention.atRisk++; else if (d <= 90) retention.inactive++; else retention.churned++
      if (d > 30 && d <= 90) atRisk.push({ name: r.name || 'Cliente', days: Math.round(d), spend: Number(r.spend) })
    }
    topCustomers = rows.map(r => ({ name: r.name || 'Cliente', orders: Number(r.n), spend: Number(r.spend) })).sort((a, b) => b.spend - a.spend).slice(0, 5)
    atRisk = atRisk.sort((a, b) => b.spend - a.spend).slice(0, 5)
  } catch {}

  const sentTot = (sm.sentiment.positivo + sm.sentiment.neutral + sm.sentiment.negativo) || 1
  const lines = [
    `Período: últimos ${days} días. Negocio: ${sm.account}.`,
    `Ventas: ${money(sm.revenue, sm.currency)} en ${sm.orders} pedidos.`,
    `Conversaciones: ${sm.conversations}. Contactos nuevos: ${sm.contactsAdded}.`,
    `Atención: 1ª respuesta promedio ${fmtDur(sm.avgFrt)}; ${sm.attendedPct}% atendidas; ${sm.derivedPct}% derivadas a humano.`,
    `Pipeline: ${sm.dealsOpen} deals abiertos, valor ${money(sm.dealsValue, sm.currency)}, ${sm.dealsWon} ganados.`,
    `Temas más frecuentes: ${sm.topics.length ? sm.topics.map(t => `${t.topic}(${t.count})`).join(', ') : 'sin datos'}.`,
    `Sentimiento: ${Math.round(sm.sentiment.positivo / sentTot * 100)}% positivo, ${Math.round(sm.sentiment.negativo / sentTot * 100)}% negativo.`,
    `Clientes: ${retention.active} activos, ${retention.atRisk} en riesgo, ${retention.inactive} inactivos, ${retention.churned} perdidos.`,
    topCustomers.length ? `Top clientes: ${topCustomers.map(c => `${c.name} (${money(c.spend, sm.currency)}, ${c.orders} pedidos)`).join('; ')}.` : '',
    atRisk.length ? `Clientes en riesgo (a reconquistar): ${atRisk.map(c => `${c.name} (sin comprar ${c.days}d, gastó ${money(c.spend, sm.currency)})`).join('; ')}.` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

const SYS = `Eres el copiloto de negocio de una plataforma de atención al cliente con IA.
Respondes al DUEÑO del negocio con base ÚNICAMENTE en los DATOS que se te entregan.
Reglas:
- Responde en español, claro y conciso (máx. ~6 líneas).
- Usa los números de los datos; no inventes cifras.
- Si la pregunta no se puede responder con los datos, dilo y sugiere qué mirar.
- Cuando aplique, cierra con UNA recomendación accionable y concreta.`

async function ask(accId, question, days = 30) {
  const model = await businessModel()
  const provider = detectProvider(model)
  const { key: apiKey } = await resolveProviderKey(accId, provider)
  if (!apiKey) return { ok: false, error: `Sin API key para ${provider}. Configúrala en la cuenta o en el Super Panel.` }
  const context = await buildContext(accId, days)
  const userPrompt = `DATOS DEL NEGOCIO:\n${context}\n\nPREGUNTA DEL DUEÑO: ${String(question || '').slice(0, 500)}`
  const r = await callAI({ provider, model, apiKey, systemPrompt: SYS, userPrompt, maxTokens: 500, temperature: 0.3 })
  return { ok: true, answer: (r.text || '').trim(), model }
}

module.exports = { ask, buildContext }
