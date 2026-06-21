'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const { sign } = require('../auth')
const guard = require('../services/demoGuard')
const subs = require('../services/subscriptions')
const provision = require('../services/demoProvision')

const requireSA = (req, res) => {
  if (req.user?.type !== 'superadmin') { res.status(403).json({ error: 'Solo superadmin' }); return false }
  return true
}
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || ''

const OWNER_PERMS = '{"inbox":true,"agents":true,"channels":true,"crm":true,"pipeline":true,"config":true,"admins":true,"flows":true,"variables":true,"tools":true,"knowledge":true}'
const AGENT_PERMS = '{"inbox":true,"agents":false,"channels":false,"crm":true,"pipeline":true,"config":false,"admins":false,"flows":false,"variables":false,"tools":false,"knowledge":false}'

// ¿Está habilitado el registro Demo? (interruptor global del SuperAdmin)
async function registrationEnabled() {
  try { const [[r]] = await pool.query('SELECT demo_registration_enabled FROM platform_settings WHERE id=1'); return r ? r.demo_registration_enabled !== 0 : true }
  catch { return true }
}

// ── Registro público de cuenta Demo (onboarding inteligente) ───────────────────
const signup = async (req, res) => {
  const b = req.body || {}
  const { name, email, password, phone, fingerprint, company, country, industry, iaName } = b
  const ip = clientIp(req)
  if (!await registrationEnabled()) return res.status(403).json({ error: 'El registro de cuentas Demo está deshabilitado temporalmente.' })
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, correo y contraseña son obligatorios' })
  // Datos del onboarding (todo lo del diagnóstico) para generar la IA y métricas.
  const onboarding = {
    iaName, industry, businessType: b.businessType, objective: b.objective,
    company, country, city: b.city, website: b.website,
    whatCompanyDoes: b.whatCompanyDoes, products: b.products, services: b.services, differentiator: b.differentiator,
    idealClient: b.idealClient, faqs: b.faqs, objections: b.objections,
    salesProcess: b.salesProcess, infoBeforeBuying: b.infoBeforeBuying,
    hours: b.hours, coverage: b.coverage, contactChannels: b.contactChannels,
  }
  try {
    // ¿Correo ya registrado como miembro? (no relacionado con el antifraude Demo, pero evita choque)
    const [[dupe]] = await pool.query('SELECT 1 AS x FROM members WHERE email=? LIMIT 1', [email.trim().toLowerCase()])
    if (dupe) return res.status(409).json({ error: 'Ya existe una cuenta con este correo. Inicia sesión.' })

    // Validación antifraude (correo / IP / fingerprint / teléfono)
    const v = await guard.validate({ email, ip, fingerprint, phone })
    if (!v.ok) {
      await guard.recordAttempt({ email, ip, fingerprint, phone, result: v.result, reason: v.message })
      return res.status(403).json({ error: v.message, reason: v.result })
    }

    // Tipo de cuenta Demo configurado
    const types = await subs.listTypes()
    const demoType = types.find(t => t.isDemo)
    if (!demoType) return res.status(500).json({ error: 'El tipo de cuenta Demo no está configurado. Contacta a soporte.' })

    // Crear cuenta + roles + owner member
    const accId = 'acc_' + uid()
    await pool.query(
      'INSERT INTO accounts (id,name,email,plan,status,channel_limits_override) VALUES (?,?,?,?,?,?)',
      [accId, name.trim(), email.trim().toLowerCase(), 'free', 'active', '{}']
    )
    const ownerRoleId = 'role_owner_' + uid()
    await pool.query('INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,1,?)', [ownerRoleId, accId, 'Owner', OWNER_PERMS])
    await pool.query('INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,0,?)', ['role_agent_' + uid(), accId, 'Agente', AGENT_PERMS])
    const memId = 'mem_' + uid()
    await pool.query(
      'INSERT INTO members (id,account_id,name,email,password,avatar,role_id,agent_access,status) VALUES (?,?,?,?,?,?,?,?,?)',
      [memId, accId, name.trim(), email.trim().toLowerCase(), password, (name || '').slice(0, 2).toUpperCase(), ownerRoleId, '[]', 'active']
    )

    // Asignar suscripción Demo (fija demo_started_at / demo_expires_at)
    await subs.assignSubscription(accId, { accountTypeId: demoType.id, subscriptionPlanId: null })
    const expiresAt = Date.now() + (demoType.demoDaysDuration || 7) * 86400000

    // Plantilla diligenciada (opcional): extraemos su texto para enriquecer la IA.
    let discoveryText = ''
    if (req.file) {
      try {
        const ext = (req.file.originalname || '').split('.').pop().toLowerCase()
        discoveryText = await require('../services/docExtract').extractText(req.file.buffer, ext)
      } catch { /* ignorar */ }
    }

    // Aprovisionar la IA: prompt maestro + agente + flujo de respuesta + Webchat activo.
    let prov = { agentId: null, webchatLink: null, iaName: iaName || name.trim(), masterPrompt: '' }
    try { prov = await provision.provisionDemoAgent(accId, onboarding, discoveryText) }
    catch (e) { console.warn('[demo provision]', e.message) }

    // Conversaciones de demostración (en segundo plano: no retrasa la respuesta;
    // aparecen en el inbox vía socket cuando estén listas).
    if (prov.agentId) {
      provision.generateSampleConversations(accId, prov.agentId, onboarding, prov.masterPrompt)
        .catch(e => console.warn('[demo samples]', e.message))
    }

    // Registrar (con datos del onboarding) y consumir overrides usados
    await guard.recordAttempt({
      accountId: accId, email, ip, fingerprint, phone,
      result: v.overrideIds?.length ? 'created_override' : 'created', expiresAt,
      company, country, industry, iaName: prov.iaName, onboarding,
    })
    if (v.overrideIds?.length) await guard.consumeOverrides(v.overrideIds)

    // Auto-login: token de sesión del owner recién creado
    const session = {
      type: 'member', id: memId, name: name.trim(), email: email.trim().toLowerCase(),
      accountId: accId, accountName: name.trim(), allAccountIds: [accId],
      roleId: ownerRoleId, permissions: parseJ(OWNER_PERMS, {}), agentAccess: [],
    }
    // URL pública del webchat para "Probar mi IA"
    const base = (process.env.PUBLIC_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const webchatUrl = prov.agentId && prov.webchatLink ? `${base}/chat/${accId}/${prov.agentId}/${prov.webchatLink}` : null
    res.json({
      ok: true, accountId: accId, agentId: prov.agentId, iaName: prov.iaName,
      webchatLink: prov.webchatLink, webchatUrl, demoExpiresAt: expiresAt,
      demoMaxConversations: demoType.demoMaxConversations || 100,
      token: sign(session), session,
    })
  } catch (err) { console.error('[demo signup]', err); res.status(500).json({ error: 'No se pudo crear la cuenta Demo' }) }
}

// ── Gestión (superadmin) ───────────────────────────────────────────────────────
const listRegistrations = async (req, res) => {
  if (!requireSA(req, res)) return
  try { res.json(await guard.listRegistrations({ limit: req.query.limit, result: req.query.result, q: req.query.q })) }
  catch (err) { console.error('[demo regs]', err); res.status(500).json({ error: 'Error interno' }) }
}
const listOverrides = async (req, res) => {
  if (!requireSA(req, res)) return
  try { res.json({ overrides: await guard.listOverrides(), ipRestrictionEnabled: await guard.ipRestrictionEnabled() }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}
const allow = async (req, res) => {
  if (!requireSA(req, res)) return
  try { const ids = await guard.allow(req.body || {}, req.user?.email || 'superadmin'); res.json({ ok: true, added: ids.length }) }
  catch (err) { console.error('[demo allow]', err); res.status(500).json({ error: 'Error interno' }) }
}
const removeOverride = async (req, res) => {
  if (!requireSA(req, res)) return
  try { await guard.removeOverride(req.params.id); res.json({ ok: true }) } catch { res.status(500).json({ error: 'Error interno' }) }
}
const setIpRestriction = async (req, res) => {
  if (!requireSA(req, res)) return
  try { await guard.setIpRestriction(!!req.body?.enabled, req.user?.email); res.json({ ok: true, enabled: !!req.body?.enabled }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

// ── Dashboard de Demos (superadmin) ────────────────────────────────────────────
const getDashboard = async (req, res) => {
  if (!requireSA(req, res)) return
  const now = Date.now(), DAY = 86400000
  try {
    const [regs] = await pool.query("SELECT * FROM demo_registrations WHERE result IN ('created','created_override') ORDER BY created_at DESC")
    const accIds = regs.map(r => r.account_id).filter(Boolean)
    let subByAcc = {}
    if (accIds.length) {
      const [srows] = await pool.query(
        `SELECT account_id, conversation_count_current_period AS used, demo_expires_at, status FROM account_subscriptions WHERE account_id IN (${accIds.map(() => '?').join(',')})`, accIds)
      subByAcc = Object.fromEntries(srows.map(s => [s.account_id, s]))
    }
    const types = await subs.listTypes()
    const maxConv = types.find(t => t.isDemo)?.demoMaxConversations || 100

    const list = regs.map(r => {
      const s = subByAcc[r.account_id]
      const used = s?.used || 0
      const expiresAt = s?.demo_expires_at || r.expires_at
      const daysLeft = expiresAt ? Math.ceil((expiresAt - now) / DAY) : null
      const converted = r.status === 'converted'
      const expired = !converted && ((s?.status === 'expired') || (expiresAt && now > expiresAt))
      const pct = maxConv ? Math.round((used / maxConv) * 100) : null
      return {
        id: r.id, accountId: r.account_id, company: r.company || '(sin nombre)', email: r.email,
        country: r.country || '—', industry: r.industry || '—', iaName: r.ia_name,
        createdAt: r.created_at, expiresAt, daysLeft, used, maxConv, pct,
        converted, expired, active: !converted && !expired,
      }
    })

    const kpis = {
      created: list.length,
      active: list.filter(x => x.active).length,
      expired: list.filter(x => x.expired).length,
      expiringSoon: list.filter(x => x.active && x.daysLeft != null && x.daysLeft <= 3).length,
      conversions: list.filter(x => x.converted).length,
      conversionRate: list.length ? Math.round((list.filter(x => x.converted).length / list.length) * 100) : 0,
    }
    const byIndustry = {}, byCountry = {}
    for (const x of list) {
      if (x.industry && x.industry !== '—') byIndustry[x.industry] = (byIndustry[x.industry] || 0) + 1
      if (x.country && x.country !== '—') byCountry[x.country] = (byCountry[x.country] || 0) + 1
    }
    const alerts = []
    for (const x of list) {
      if (x.converted) continue
      if (x.active && x.daysLeft != null && x.daysLeft <= 1) alerts.push({ sev: 'crit', company: x.company, text: x.daysLeft <= 0 ? 'Demo vence hoy' : 'Demo vence mañana' })
      else if (x.active && x.daysLeft != null && x.daysLeft <= 3) alerts.push({ sev: 'warn', company: x.company, text: `Demo vence en ${x.daysLeft} días` })
      if (x.pct != null && x.pct >= 100) alerts.push({ sev: 'crit', company: x.company, text: 'Consumo 100%' })
      else if (x.pct != null && x.pct >= 90) alerts.push({ sev: 'warn', company: x.company, text: `Consumo ${x.pct}%` })
      else if (x.pct != null && x.pct >= 80) alerts.push({ sev: 'info', company: x.company, text: `Consumo ${x.pct}%` })
    }
    const order = { crit: 0, warn: 1, info: 2 }
    alerts.sort((a, b) => order[a.sev] - order[b.sev])

    const lists = {
      expiring: list.filter(x => x.active && x.daysLeft != null).sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 20),
      mostUsed: [...list].sort((a, b) => b.used - a.used).slice(0, 20),
      // Mayor probabilidad de conversión: heurística por uso + consumo + antigüedad activa.
      likely: list.filter(x => x.active).map(x => ({ ...x, score: (x.used || 0) * 2 + (x.pct || 0) + Math.max(0, 7 - (x.daysLeft || 7)) }))
        .sort((a, b) => b.score - a.score).slice(0, 20),
      converted: list.filter(x => x.converted),
    }
    res.json({ kpis, byIndustry, byCountry, alerts: alerts.slice(0, 60), lists, generatedAt: now })
  } catch (err) { console.error('[demo dashboard]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Estado público del registro Demo (lo consulta el asistente) ────────────────
const publicStatus = async (req, res) => {
  try {
    const enabled = await registrationEnabled()
    const [[t]] = await pool.query('SELECT id, name FROM demo_templates WHERE active=1 LIMIT 1')
    res.json({ enabled, hasTemplate: !!t, templateName: t?.name || null })
  } catch { res.json({ enabled: true, hasTemplate: false }) }
}

// Descarga PÚBLICA de la plantilla activa (la usa el asistente de onboarding).
const downloadActiveTemplate = async (req, res) => {
  try {
    const [[t]] = await pool.query('SELECT * FROM demo_templates WHERE active=1 LIMIT 1')
    if (!t) return res.status(404).json({ error: 'No hay plantilla activa' })
    sendTemplate(res, t)
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

function sendTemplate(res, t) {
  // Falta de contenido → 404 claro (en vez de reventar Buffer.from con null).
  if (!t || t.data_base64 == null || t.data_base64 === '') {
    return res.status(404).json({ error: 'La plantilla no tiene contenido almacenado.' })
  }
  let buf
  try { buf = Buffer.from(String(t.data_base64), 'base64') }
  catch { return res.status(500).json({ error: 'No se pudo decodificar la plantilla.' }) }

  // El nombre real puede tener acentos/caracteres no-ASCII (p. ej. "INFORMACIÓN"),
  // que NO son válidos en una cabecera HTTP y hacían reventar res.setHeader →
  // 500 "Internal Server Error". Usamos un nombre ASCII seguro para filename= y
  // el nombre real en filename*=UTF-8'' (RFC 5987) para clientes que lo soporten.
  const rawName   = String(t.filename || 'plantilla')
  const asciiName = rawName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
  res.setHeader('Content-Type', String(t.mime || 'application/octet-stream').replace(/[^\x20-\x7e]/g, ''))
  res.setHeader('Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`)
  res.send(buf)
}

// ── Gestión de plantillas (superadmin) ─────────────────────────────────────────
const listTemplates = async (req, res) => {
  if (!requireSA(req, res)) return
  try {
    const [rows] = await pool.query('SELECT id,name,filename,mime,ext,size_bytes,active,created_by,created_at FROM demo_templates ORDER BY created_at DESC')
    res.json(rows)
  } catch { res.status(500).json({ error: 'Error interno' }) }
}
const uploadTemplate = async (req, res) => {
  if (!requireSA(req, res)) return
  if (!req.file) return res.status(400).json({ error: 'No llegó el archivo. Vuelve a seleccionarlo.' })
  const fname = String(req.file.originalname || 'plantilla')
  const ext = fname.split('.').pop().toLowerCase()
  const mime = String(req.file.mimetype || '')
  const okByExt = ['pdf', 'docx', 'doc'].includes(ext)
  const okByMime = /pdf|word|officedocument/.test(mime)
  if (!okByExt && !okByMime) return res.status(400).json({ error: `Formato no soportado (.${ext}). Usa PDF o DOCX.` })
  try {
    const id = 'dtpl_' + uid()
    // Recortamos a los límites de las columnas para evitar errores de truncado.
    const name = String(req.body?.name || fname).slice(0, 150)
    await pool.query('UPDATE demo_templates SET active=0') // solo una activa
    await pool.query(
      'INSERT INTO demo_templates (id,name,filename,mime,ext,size_bytes,data_base64,active,created_by,created_at) VALUES (?,?,?,?,?,?,?,1,?,?)',
      [id, name, fname.slice(0, 200), mime.slice(0, 120), (okByExt ? ext : (mime.includes('pdf') ? 'pdf' : 'docx')).slice(0, 10),
       req.file.size, req.file.buffer.toString('base64'), String(req.user?.email || 'superadmin').slice(0, 120), Date.now()]
    )
    res.json({ id })
  } catch (err) {
    console.error('[uploadTemplate]', err)
    // Mensaje real (solo superadmin) para poder diagnosticar.
    res.status(500).json({ error: 'No se pudo guardar la plantilla: ' + (err.sqlMessage || err.message || 'error interno') })
  }
}
const activateTemplate = async (req, res) => {
  if (!requireSA(req, res)) return
  try { await pool.query('UPDATE demo_templates SET active=0'); await pool.query('UPDATE demo_templates SET active=1 WHERE id=?', [req.params.id]); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}
const deleteTemplate = async (req, res) => {
  if (!requireSA(req, res)) return
  try { await pool.query('DELETE FROM demo_templates WHERE id=?', [req.params.id]); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}
const downloadTemplate = async (req, res) => {
  if (!requireSA(req, res)) return
  try {
    const [[t]] = await pool.query('SELECT * FROM demo_templates WHERE id=?', [req.params.id])
    if (!t) return res.status(404).json({ error: 'No encontrada' })
    sendTemplate(res, t)
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

// ── Interruptor del registro Demo (superadmin) ─────────────────────────────────
const getRegistration = async (req, res) => {
  if (!requireSA(req, res)) return
  res.json({ enabled: await registrationEnabled() })
}
const setRegistration = async (req, res) => {
  if (!requireSA(req, res)) return
  try { await pool.query('UPDATE platform_settings SET demo_registration_enabled=? WHERE id=1', [req.body?.enabled ? 1 : 0]); res.json({ ok: true, enabled: !!req.body?.enabled }) }
  catch { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = {
  signup, listRegistrations, listOverrides, allow, removeOverride, setIpRestriction,
  publicStatus, downloadActiveTemplate, listTemplates, uploadTemplate, activateTemplate, deleteTemplate, downloadTemplate,
  getRegistration, setRegistration, getDashboard,
}
