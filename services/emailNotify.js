'use strict'
/**
 * Notificaciones por CORREO a los miembros del equipo, según sus preferencias
 * (members.notif_prefs). Reutiliza el proveedor de correo configurado (SMTP/Resend/
 * SendGrid) vía services/email. El canal "Correo" viene APAGADO por defecto: solo se
 * envía a quien lo activó en su perfil. Eventos cubiertos:
 *   - new_chat   : entra un chat nuevo (1 vez, al crearse la conversación)
 *   - transfer   : se asigna/transfiere una conversación a un asesor
 *   - task       : se asigna una tarea, o está por vencer (recordatorio)
 *   - flow_error : un flujo falla durante su ejecución
 * Best-effort: nunca lanza (no debe romper el flujo que lo dispara).
 */
const pool = require('../db')
const { parseJ } = require('../utils')
const { sendEmail, loadEmailConfig, isConfigured } = require('./email')

// `type` de evento → clave de preferencia (igual que el front en lib/notifPrefs.js).
const TYPE_TO_PREF = { new_chat: 'new_chat', transfer: 'transfer', task: 'task', flow_error: 'flow_error' }

// ¿Está activado el canal Correo para este tipo en las prefs del miembro?
// Correo por defecto APAGADO (opt-in): sin pref guardada → false.
function emailOn(prefsJson, type) {
  const key = TYPE_TO_PREF[type] || type
  const prefs = parseJ(prefsJson, null)
  if (!prefs || !prefs[key]) return false
  return prefs[key].email === true
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

async function loadBrand() {
  try {
    const [[s]] = await pool.query('SELECT brand_name, brand_logo FROM platform_settings WHERE id=1')
    return { name: s?.brand_name || 'AVI Asistente', logo: s?.brand_logo || '' }
  } catch { return { name: 'AVI Asistente', logo: '' } }
}

// Tarjeta HTML del correo de notificación (title + líneas + acento de color).
function cardHtml({ emoji, title, lines = [], accent = '#0b8a4f', brand }) {
  const logo = brand?.logo ? `<img src="${esc(brand.logo)}" alt="" style="max-height:40px;margin:0 auto 12px;display:block;">` : ''
  const body = lines.map(l => `<p style="margin:0 0 10px;font-size:14px;color:#444;line-height:1.5;">${l}</p>`).join('')
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:30px 20px;">
      <div style="background:#fff;border-radius:14px;padding:26px 24px;box-shadow:0 2px 10px rgba(0,0,0,.06);border-top:4px solid ${esc(accent)};">
        ${logo}
        <h1 style="margin:0 0 14px;font-size:18px;color:#111;">${esc(emoji)} ${esc(title)}</h1>
        ${body}
      </div>
      <p style="text-align:center;font-size:11px;color:#aab;margin-top:14px;">${esc(brand?.name || 'AVI Asistente')}</p>
    </div></body></html>`
}

// Envía a una lista de miembros [{email, notif_prefs}] filtrando por su preferencia.
async function sendToMembers(members, type, { subject, emoji, title, lines, accent }) {
  const cfg = await loadEmailConfig()
  if (!isConfigured(cfg)) return
  const targets = (members || []).filter(m => m?.email && emailOn(m.notif_prefs, type))
  if (!targets.length) return
  const brand = await loadBrand()
  const html = cardHtml({ emoji, title, lines, accent, brand })
  const text = `${title}\n\n${(lines || []).map(l => String(l).replace(/<[^>]+>/g, '')).join('\n')}`
  for (const m of targets) {
    try { await sendEmail({ to: m.email, cfg, subject, html, text }) }
    catch (e) { console.warn('[emailNotify send]', e.message) }
  }
}

// Anti-duplicados en memoria (best-effort; se reinicia al reiniciar el server).
const _last = new Map()
function throttled(key, ms) {
  const now = Date.now(); const prev = _last.get(key)
  if (prev && now - prev < ms) return true
  _last.set(key, now)
  if (_last.size > 5000) { for (const [k, t] of _last) if (now - t > 3600000) _last.delete(k) }
  return false
}

// ── Eventos ──────────────────────────────────────────────────────────────────

// Chat nuevo (1 vez): avisa a los miembros activos que activaron "Chat nuevo → Correo".
async function onNewChat(accId, { convId, guestName, channelType } = {}) {
  try {
    const [members] = await pool.query("SELECT email, notif_prefs FROM members WHERE account_id=? AND status<>'inactive'", [accId])
    await sendToMembers(members, 'new_chat', {
      subject: `🆕 Chat nuevo: ${guestName || 'cliente'}`,
      emoji: '🆕', title: 'Nuevo chat',
      lines: [
        `Entró una nueva conversación de <strong>${esc(guestName || 'un cliente')}</strong>${channelType ? ' por ' + esc(channelType) : ''}.`,
        'Ábrela en tu bandeja de AVI para atenderla.',
      ],
      accent: '#3b82f6',
    })
  } catch (e) { console.warn('[emailNotify newChat]', e.message) }
}

// Conversación asignada / transferida a un asesor concreto.
async function onAssigned(accId, { convId, assigneeId, guestName, assignedBy } = {}) {
  if (!assigneeId) return
  if (throttled(`assign:${convId}:${assigneeId}`, 5 * 60000)) return
  try {
    const [members] = await pool.query('SELECT email, notif_prefs FROM members WHERE account_id=? AND id=?', [accId, assigneeId])
    if (!members.length) return
    if (!guestName) { try { const [[c]] = await pool.query('SELECT guest_name FROM conversations WHERE id=? AND account_id=?', [convId, accId]); guestName = c?.guest_name } catch {} }
    await sendToMembers(members, 'transfer', {
      subject: `👤 Se te asignó un chat: ${guestName || 'cliente'}`,
      emoji: '👤', title: 'Conversación asignada a ti',
      lines: [
        `${assignedBy ? esc(assignedBy) + ' te' : 'Se te'} asignó la conversación de <strong>${esc(guestName || 'un cliente')}</strong>.`,
        'Ábrela en tu bandeja de AVI para continuar la atención.',
      ],
      accent: '#7c6fff',
    })
  } catch (e) { console.warn('[emailNotify assigned]', e.message) }
}

// Tarea asignada a un miembro.
async function onTaskAssigned(accId, { taskId, title, assigneeId, dueAt } = {}) {
  if (!assigneeId) return
  if (throttled(`task:${taskId}:${assigneeId}`, 5 * 60000)) return
  try {
    const [members] = await pool.query('SELECT email, notif_prefs FROM members WHERE account_id=? AND id=?', [accId, assigneeId])
    if (!members.length) return
    const due = dueAt ? new Date(Number(dueAt)).toLocaleString('es') : ''
    await sendToMembers(members, 'task', {
      subject: `✅ Nueva tarea: ${title || 'sin título'}`,
      emoji: '✅', title: 'Tarea asignada a ti',
      lines: [
        `Se te asignó la tarea <strong>${esc(title || 'sin título')}</strong>.`,
        ...(due ? [`Vence: <strong>${esc(due)}</strong>.`] : []),
        'Revísala en el CRM de AVI.',
      ],
      accent: '#0b8a4f',
    })
  } catch (e) { console.warn('[emailNotify task]', e.message) }
}

// Error de ejecución de un flujo.
async function onFlowError(accId, { flowName, node, error } = {}) {
  if (throttled(`flowerr:${accId}:${flowName || ''}:${error || ''}`, 5 * 60000)) return
  try {
    const [members] = await pool.query("SELECT email, notif_prefs FROM members WHERE account_id=? AND status<>'inactive'", [accId])
    await sendToMembers(members, 'flow_error', {
      subject: `⚠️ Error en un flujo${flowName ? ': ' + flowName : ''}`,
      emoji: '⚠️', title: 'Error en un flujo',
      lines: [
        `El flujo <strong>${esc(flowName || 'sin nombre')}</strong>${node ? ' (nodo ' + esc(node) + ')' : ''} falló durante su ejecución.`,
        `<span style="color:#c0392b;">${esc(error || 'Fallo de ejecución')}</span>`,
        'Revisa el flujo en AVI.',
      ],
      accent: '#ef4444',
    })
  } catch (e) { console.warn('[emailNotify flowError]', e.message) }
}

// ── Worker: recordatorio de tareas por vencer ────────────────────────────────
// Revisa tareas abiertas cuyo due_at está dentro de la próxima hora (o ya vencido y
// sin avisar) y manda UN recordatorio al asignado. due_reminded_at evita repetir.
async function dueTick() {
  try {
    const cfg = await loadEmailConfig()
    if (!isConfigured(cfg)) return   // sin proveedor: no marcamos, para recuperar al configurarlo
    const now = Date.now()
    const soon = now + 60 * 60000    // 1h de antelación
    const [rows] = await pool.query(
      "SELECT id, account_id, title, due_at, assignee_id FROM crm_tasks WHERE status='open' AND assignee_id IS NOT NULL AND due_at IS NOT NULL AND due_at<=? AND (due_reminded_at IS NULL OR due_reminded_at=0) LIMIT 200",
      [soon])
    for (const t of rows) {
      try {
        const [members] = await pool.query('SELECT email, notif_prefs FROM members WHERE account_id=? AND id=?', [t.account_id, t.assignee_id])
        const overdue = Number(t.due_at) < now
        const due = t.due_at ? new Date(Number(t.due_at)).toLocaleString('es') : ''
        await sendToMembers(members, 'task', {
          subject: `⏰ Tarea ${overdue ? 'vencida' : 'por vencer'}: ${t.title || 'sin título'}`,
          emoji: '⏰', title: overdue ? 'Tarea vencida' : 'Tarea por vencer',
          lines: [
            `La tarea <strong>${esc(t.title || 'sin título')}</strong> ${overdue ? 'venció' : 'vence'} ${due ? 'el <strong>' + esc(due) + '</strong>' : 'pronto'}.`,
            'Complétala o actualízala en el CRM de AVI.',
          ],
          accent: overdue ? '#ef4444' : '#f59e0b',
        })
        await pool.query('UPDATE crm_tasks SET due_reminded_at=? WHERE id=?', [now, t.id])
      } catch (e) { console.warn('[emailNotify dueTick task]', t.id, e.message) }
    }
  } catch (e) { console.warn('[emailNotify dueTick]', e.message) }
}

let _timer = null
function startWorker() {
  if (_timer) return
  _timer = setInterval(() => dueTick().catch(() => {}), 5 * 60000)   // cada 5 min
  _timer.unref?.()
  setTimeout(() => dueTick().catch(() => {}), 45000)                  // primer pase a los 45s
}

module.exports = { onNewChat, onAssigned, onTaskAssigned, onFlowError, startWorker, dueTick }
