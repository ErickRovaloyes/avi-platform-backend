'use strict'
// Resumen ejecutivo por cuenta: agrega la actividad del período y arma un email para el dueño.
const pool = require('../db')

const DAY = 86400000
const TOPIC_LABEL = { ventas: 'Ventas', soporte: 'Soporte', queja: 'Quejas', informacion: 'Información', agendamiento: 'Agendamiento', pedido: 'Pedidos', otro: 'Otro' }

function fmtDur(ms) {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60); if (m < 60) return `${m} min`
  const h = Math.floor(m / 60); return `${h}h ${m % 60}m`
}
const money = (n, c) => `${Math.round(Number(n) || 0).toLocaleString('es-CO')} ${c || ''}`.trim()

async function buildSummary(accId, days = 7) {
  const to = Date.now(), from = to - days * DAY
  const [[acc]] = await pool.query('SELECT name, email FROM accounts WHERE id=?', [accId])

  const [[conv]] = await pool.query('SELECT COUNT(*) AS n FROM conversations WHERE account_id=? AND created_at BETWEEN ? AND ?', [accId, from, to])
  const [[cont]] = await pool.query('SELECT COUNT(*) AS n FROM contacts WHERE account_id=? AND created_at BETWEEN ? AND ?', [accId, from, to])

  let orders = 0, revenue = 0, currency = 'COP'
  try {
    const [[o]] = await pool.query("SELECT COUNT(*) AS n, SUM(total) AS rev FROM orders WHERE account_id=? AND status NOT IN('draft','canceled') AND created_at BETWEEN ? AND ?", [accId, from, to])
    orders = Number(o?.n || 0); revenue = Number(o?.rev || 0)
    const [[cur]] = await pool.query("SELECT currency FROM orders WHERE account_id=? AND currency IS NOT NULL LIMIT 1", [accId])
    if (cur?.currency) currency = cur.currency
  } catch {}

  let avgFrt = null, attendedPct = 0, derivedPct = 0
  try {
    const [[fr]] = await pool.query('SELECT AVG(first_response_ms) AS a FROM conversations WHERE account_id=? AND first_response_ms IS NOT NULL AND created_at BETWEEN ? AND ?', [accId, from, to])
    avgFrt = fr?.a != null ? Math.round(Number(fr.a)) : null
    const [orow] = await pool.query('SELECT outcome, COUNT(*) AS n FROM conversations WHERE account_id=? AND outcome IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY outcome', [accId, from, to])
    const tot = orow.reduce((s, r) => s + Number(r.n), 0) || 1
    attendedPct = Math.round((orow.find(r => r.outcome === 'atendido')?.n || 0) / tot * 100)
    derivedPct = Math.round((orow.find(r => r.outcome === 'derivado')?.n || 0) / tot * 100)
  } catch {}

  let topics = [], sentiment = { positivo: 0, neutral: 0, negativo: 0 }
  try {
    const [tr] = await pool.query('SELECT topic, COUNT(*) AS n FROM conversations WHERE account_id=? AND topic IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY topic ORDER BY n DESC LIMIT 3', [accId, from, to])
    topics = tr.map(r => ({ topic: r.topic, count: Number(r.n) }))
    const [sr] = await pool.query('SELECT sentiment, COUNT(*) AS n FROM conversations WHERE account_id=? AND sentiment IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY sentiment', [accId, from, to])
    for (const r of sr) sentiment[r.sentiment] = Number(r.n)
  } catch {}

  // Deals (viven como JSON en pipelines)
  let dealsOpen = 0, dealsValue = 0, dealsWon = 0
  try {
    const [pipes] = await pool.query('SELECT stages, cards FROM pipelines WHERE account_id=?', [accId])
    for (const p of pipes) {
      let stages = [], cards = []
      try { stages = JSON.parse(p.stages) || [] } catch {}
      try { cards = JSON.parse(p.cards) || [] } catch {}
      const stById = Object.fromEntries(stages.map(s => [s.id, s]))
      for (const c of cards) {
        dealsOpen++; dealsValue += Number(c.value || 0)
        const st = stById[c.stageId]
        if (c.won || st?.name?.toLowerCase().match(/(ganado|cerrado|won)/)) dealsWon++
      }
    }
  } catch {}

  return {
    account: acc?.name || '', ownerEmail: acc?.email || '', days, from, to, currency,
    conversations: Number(conv?.n || 0), contactsAdded: Number(cont?.n || 0),
    orders, revenue, avgFrt, attendedPct, derivedPct,
    topics, sentiment, dealsOpen, dealsValue, dealsWon,
  }
}

function buildHtml(sm) {
  const d = new Date(sm.to).toLocaleDateString('es', { day: '2-digit', month: 'long', year: 'numeric' })
  const tCard = (label, value, sub) => `<td style="padding:8px;"><div style="background:#f4f7f5;border:1px solid #e2e7e1;border-radius:10px;padding:12px 14px;"><div style="font-size:20px;font-weight:800;color:#12241b;">${value}</div><div style="font-size:11px;color:#5c6b63;margin-top:2px;font-weight:600;">${label}</div>${sub ? `<div style="font-size:10px;color:#8b9a90;margin-top:1px;">${sub}</div>` : ''}</div></td>`
  const topTopics = sm.topics.length ? sm.topics.map(t => `${TOPIC_LABEL[t.topic] || t.topic} (${t.count})`).join(' · ') : '—'
  const sentTot = (sm.sentiment.positivo + sm.sentiment.neutral + sm.sentiment.negativo) || 1
  const pos = Math.round(sm.sentiment.positivo / sentTot * 100), neg = Math.round(sm.sentiment.negativo / sentTot * 100)
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#12241b;">
    <div style="background:linear-gradient(135deg,#0ea968,#6a53e6);padding:22px 24px;border-radius:14px 14px 0 0;color:#fff;">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.85;">Resumen ejecutivo · últimos ${sm.days} días</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px;">${sm.account}</div>
      <div style="font-size:12px;opacity:.85;">al ${d}</div>
    </div>
    <div style="border:1px solid #e2e7e1;border-top:none;border-radius:0 0 14px 14px;padding:12px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>${tCard('Ventas', money(sm.revenue, sm.currency), `${sm.orders} pedidos`)}${tCard('Conversaciones', sm.conversations, `${sm.contactsAdded} contactos nuevos`)}</tr>
        <tr>${tCard('1ª respuesta prom.', fmtDur(sm.avgFrt), `${sm.attendedPct}% atendidas`)}${tCard('Pipeline', money(sm.dealsValue, sm.currency), `${sm.dealsOpen} deals · ${sm.dealsWon} ganados`)}</tr>
      </table>
      <div style="padding:10px 12px;">
        <div style="font-size:13px;margin:8px 0;"><b>De qué hablaron tus clientes:</b> ${topTopics}</div>
        <div style="font-size:13px;margin:8px 0;"><b>Sentimiento:</b> 😊 ${pos}% positivo · 😠 ${neg}% negativo</div>
        <div style="font-size:13px;margin:8px 0;"><b>Derivado a humano:</b> ${sm.derivedPct}% de las conversaciones</div>
      </div>
      <div style="font-size:11px;color:#8b9a90;text-align:center;padding:10px;border-top:1px solid #e2e7e1;margin-top:6px;">Generado automáticamente por tu asistente AVI.</div>
    </div>
  </div>`
}

module.exports = { buildSummary, buildHtml }
