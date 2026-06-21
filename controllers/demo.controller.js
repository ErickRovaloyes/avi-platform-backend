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

// ── Registro público de cuenta Demo (onboarding inteligente) ───────────────────
const signup = async (req, res) => {
  const b = req.body || {}
  const { name, email, password, phone, fingerprint, company, country, industry, iaName } = b
  const ip = clientIp(req)
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

    // Aprovisionar la IA: prompt maestro + agente + flujo de respuesta + Webchat activo.
    let prov = { agentId: null, webchatLink: null, iaName: iaName || name.trim() }
    try { prov = await provision.provisionDemoAgent(accId, onboarding) }
    catch (e) { console.warn('[demo provision]', e.message) }

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

module.exports = { signup, listRegistrations, listOverrides, allow, removeOverride, setIpRestriction }
