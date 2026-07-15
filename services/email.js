'use strict'
// Correo transaccional sin dependencias nuevas: usa la API HTTP del proveedor
// (Resend o SendGrid) vía fetch (Node 18+). El super admin configura el proveedor,
// la API key y el remitente desde el Super Panel. Si no hay proveedor configurado
// nada se envía (todo el sistema de verificación/2FA queda inactivo).
const pool = require('../db')

async function loadEmailConfig() {
  try {
    const [[r]] = await pool.query('SELECT email_provider, email_api_key, email_from, email_from_name, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure FROM platform_settings WHERE id=1')
    if (!r) return null
    return {
      provider: r.email_provider || 'none',
      apiKey: r.email_api_key || '',
      from: r.email_from || '',
      fromName: r.email_from_name || 'AVI Asistente',
      smtp: {
        host: r.smtp_host || '',
        port: Number(r.smtp_port) || 587,
        user: r.smtp_user || '',
        pass: r.smtp_pass || '',
        secure: !!r.smtp_secure,   // true = TLS directo (465); false = STARTTLS (587)
      },
    }
  } catch { return null }
}

function isConfigured(cfg) {
  if (!cfg) return false
  if (cfg.provider === 'smtp') return !!(cfg.smtp?.host && cfg.smtp?.user && cfg.smtp?.pass && cfg.from)
  return !!(cfg.provider && cfg.provider !== 'none' && cfg.apiKey && cfg.from)
}

// Transporter SMTP cacheado (se reconstruye si cambia la config).
let _smtpTx = null, _smtpKey = ''
function smtpTransport(smtp) {
  const key = `${smtp.host}|${smtp.port}|${smtp.user}|${smtp.secure}|${(smtp.pass || '').slice(-4)}`
  if (_smtpTx && _smtpKey === key) return _smtpTx
  const nodemailer = require('nodemailer')
  _smtpTx = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  })
  _smtpKey = key
  return _smtpTx
}

// Envía un correo. Devuelve { ok, error }.
async function sendEmail({ to, subject, html, text, cfg }) {
  const config = cfg || await loadEmailConfig()
  if (!isConfigured(config)) return { ok: false, error: 'Correo no configurado' }
  const fromHeader = config.fromName ? `${config.fromName} <${config.from}>` : config.from
  try {
    if (config.provider === 'smtp') {
      const info = await smtpTransport(config.smtp).sendMail({
        from: fromHeader, to, subject, html, text: text || undefined,
      })
      if (info?.rejected?.length) return { ok: false, error: `SMTP rechazó: ${info.rejected.join(', ')}` }
      return { ok: true }
    }
    if (config.provider === 'resend') {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromHeader, to: [to], subject, html, text: text || undefined }),
      })
      if (!resp.ok) { const t = await resp.text().catch(() => ''); return { ok: false, error: `Resend ${resp.status}: ${t.slice(0, 200)}` } }
      return { ok: true }
    }
    if (config.provider === 'sendgrid') {
      const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: config.from, name: config.fromName || undefined },
          subject,
          content: [{ type: 'text/plain', value: text || subject }, { type: 'text/html', value: html }],
        }),
      })
      if (!resp.ok) { const t = await resp.text().catch(() => ''); return { ok: false, error: `SendGrid ${resp.status}: ${t.slice(0, 200)}` } }
      return { ok: true }
    }
    return { ok: false, error: `Proveedor no soportado: ${config.provider}` }
  } catch (err) {
    return { ok: false, error: err.message || 'Error de red al enviar el correo' }
  }
}

// Plantilla HTML sencilla para códigos de verificación.
function codeEmailHtml({ code, title, intro }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:460px;margin:0 auto;padding:32px 20px;">
    <div style="background:#fff;border-radius:14px;padding:28px 26px;box-shadow:0 2px 10px rgba(0,0,0,.06);">
      <h1 style="margin:0 0 8px;font-size:19px;color:#111;">${title}</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#555;line-height:1.5;">${intro}</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0b8a4f;text-align:center;padding:14px 0;background:#eafaf1;border-radius:10px;">${code}</div>
      <p style="margin:18px 0 0;font-size:12px;color:#999;line-height:1.5;">Este código expira en 10 minutos. Si no fuiste tú, ignora este correo.</p>
    </div>
    <p style="text-align:center;font-size:11px;color:#aab;margin-top:16px;">AVI Asistente</p>
  </div></body></html>`
}

module.exports = { loadEmailConfig, isConfigured, sendEmail, codeEmailHtml }
