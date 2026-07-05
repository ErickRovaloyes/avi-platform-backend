'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const { provisionDefaultAgent } = require('../services/accountProvision')
const { extractFileText } = require('./promptGenerator.controller')

// ── Platform settings ─────────────────────────────────────────────────────────

const DEFAULT_TOKEN_LIMITS = { basic: 50000, medium: 30000, complex: 15000 }
const DEFAULT_STRUCTURE = `Eres un asistente especializado.\n\n## Contexto\n[Contexto extraído del documento]\n\n## Personalidad y tono\n[Define la personalidad]\n\n## Instrucciones\n[Instrucciones específicas paso a paso]\n\n## Reglas\n- Responde siempre en español\n- Sé conciso y empático`

const DEFAULT_CONDITIONS = `EXTENSIÓN MÍNIMA: el prompt debe tener entre 2.500 y 6.000 caracteres. Los prompts cortos generan agentes deficientes.

PROFUNDIDAD — cubre estas 12 dimensiones, cada una con varios párrafos o bullets densos:
1. IDENTIDAD Y MISIÓN
2. CONTEXTO DE NEGOCIO
3. PERSONALIDAD Y TONO (rasgos específicos, registro lingüístico, formalidad, uso de emojis)
4. CONOCIMIENTO ESPECIALIZADO (sintetiza el documento completo: precios, plazos, políticas, FAQs)
5. FLUJOS DE CONVERSACIÓN ESPERADOS
6. INSTRUCCIONES PASO A PASO
7. REGLAS DE NEGOCIO ESTRICTAS (qué SÍ y qué NO puede decir)
8. MANEJO DE OBJECIONES con frases-modelo concretas
9. CRITERIOS DE ESCALACIÓN a humano
10. ESTILO DE RESPUESTA (longitud, formato, bullets, emojis)
11. SEGURIDAD Y LÍMITES (no inventar, no compartir credenciales, rechazar contenido inapropiado)
12. MÉTRICAS DE ÉXITO

REGLAS DE FORMATO:
- En SEGUNDA PERSONA ("Eres...", "Debes...", "Cuando te pregunten...").
- Secciones con encabezados Markdown (##).
- EJEMPLOS concretos de respuestas-modelo en al menos 3 secciones.
- Usa datos REALES del documento. NO uses placeholders como "[nombre del producto]"; si el dato existe, úsalo literal.
- Termina con una sección "## Recordatorio final" sintetizando 3-5 principios clave.

INFORMACIÓN COMPLETA: el prompt debe reflejar TODA la información relevante del documento. No omitas secciones, datos, listas o reglas que aparezcan en el texto original — el agente debe poder responder cualquier pregunta razonable basándose solo en lo que está en el prompt.`

const getSettings = async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT * FROM platform_settings WHERE id=1')
    // Mask API keys for non-superadmin callers
    const isSA = req.user?.type === 'superadmin'
    const maskKey = k => !k ? '' : (isSA ? k : `sk-***${k.slice(-4)}`)

    res.json(r
      ? {
          changeAgentModel: r.change_agent_model,
          changeAgentDefaultLimit: r.change_agent_default_limit,
          changeAgentTokenLimits: parseJ(r.change_agent_token_limits, DEFAULT_TOKEN_LIMITS),
          channelLimits: parseJ(r.channel_limits, {}),
          metaAppId: r.meta_app_id || '',
          metaConfigId: r.meta_config_id || '',
          // El App Secret solo lo ve el super admin; al resto se le indica si existe.
          metaAppSecret: isSA ? (r.meta_app_secret || '') : '',
          hasMetaAppSecret: !!r.meta_app_secret,
          promptGeneratorModel: r.prompt_generator_model || 'gpt-4o',
          promptGeneratorStructure: r.prompt_generator_structure || DEFAULT_STRUCTURE,
          promptGeneratorConditions: r.prompt_generator_conditions || DEFAULT_CONDITIONS,
          promptGeneratorMaxTokens: r.prompt_generator_max_tokens || 8000,
          promptGeneratorTemperature: r.prompt_generator_temperature != null ? Number(r.prompt_generator_temperature) : 0.55,
          promptGeneratorMaxDocChars: r.prompt_generator_max_doc_chars || 200000,
          promptGeneratorAllowFlows: r.prompt_generator_allow_flows !== 0,
          promptGeneratorMaxFileMb: r.prompt_generator_max_file_mb || 30,
          // Default platform API keys (only super-admin sees full value; others see masked indicator)
          platformOpenaiKey:    maskKey(r.openai_key || ''),
          platformDeepseekKey:  maskKey(r.deepseek_key || ''),
          platformAnthropicKey: maskKey(r.anthropic_key || ''),
          hasPlatformOpenaiKey:    !!r.openai_key,
          hasPlatformDeepseekKey:  !!r.deepseek_key,
          hasPlatformAnthropicKey: !!r.anthropic_key,
          mediaMaxSizeMb: r.media_max_size_mb || 30,
          transcriptionModel: r.transcription_model || 'whisper-1',
          defaultPromptProvider: r.default_prompt_provider || 'deepseek',
          defaultPromptModel: r.default_prompt_model || 'deepseek-v4-flash',
          optimizerModel: r.optimizer_model || 'gpt-4o-mini',
        }
      : {
          changeAgentModel: 'gpt-4o-mini',
          changeAgentDefaultLimit: 20,
          changeAgentTokenLimits: DEFAULT_TOKEN_LIMITS,
          channelLimits: {},
          metaAppId: '',
          metaConfigId: '',
          metaAppSecret: '',
          hasMetaAppSecret: false,
          promptGeneratorModel: 'gpt-4o',
          promptGeneratorStructure: DEFAULT_STRUCTURE,
          promptGeneratorConditions: DEFAULT_CONDITIONS,
          promptGeneratorMaxTokens: 8000,
          promptGeneratorTemperature: 0.55,
          promptGeneratorMaxDocChars: 200000,
          promptGeneratorAllowFlows: true,
          promptGeneratorMaxFileMb: 30,
          mediaMaxSizeMb: 30,
          transcriptionModel: 'whisper-1',
          defaultPromptProvider: 'deepseek',
          defaultPromptModel: 'deepseek-v4-flash',
          optimizerModel: 'gpt-4o-mini',
        })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateSettings = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const {
    changeAgentModel, changeAgentDefaultLimit, changeAgentTokenLimits,
    channelLimits, metaAppId, metaConfigId, metaAppSecret,
    promptGeneratorModel, promptGeneratorStructure, promptGeneratorConditions,
    promptGeneratorMaxTokens, promptGeneratorTemperature, promptGeneratorMaxDocChars,
    promptGeneratorAllowFlows,
    promptGeneratorMaxFileMb,
    platformOpenaiKey, platformDeepseekKey, platformAnthropicKey,
    mediaMaxSizeMb, transcriptionModel,
    defaultPromptProvider, defaultPromptModel, optimizerModel,
  } = req.body
  try {
    const sets = []; const vals = []
    if (changeAgentModel          !== undefined) { sets.push('change_agent_model=?');           vals.push(changeAgentModel) }
    if (changeAgentDefaultLimit   !== undefined) { sets.push('change_agent_default_limit=?');   vals.push(changeAgentDefaultLimit) }
    if (changeAgentTokenLimits    !== undefined) { sets.push('change_agent_token_limits=?');    vals.push(JSON.stringify(changeAgentTokenLimits)) }
    if (channelLimits             !== undefined) { sets.push('channel_limits=?');               vals.push(JSON.stringify(channelLimits)) }
    if (metaAppId                 !== undefined) { sets.push('meta_app_id=?');                  vals.push(metaAppId) }
    if (metaConfigId              !== undefined) { sets.push('meta_config_id=?');               vals.push(metaConfigId) }
    // Solo se actualiza el secret si llega un valor no vacío (evita borrarlo al guardar enmascarado)
    if (metaAppSecret             !== undefined && metaAppSecret !== '') { sets.push('meta_app_secret=?'); vals.push(metaAppSecret) }
    if (promptGeneratorModel      !== undefined) { sets.push('prompt_generator_model=?');       vals.push(promptGeneratorModel) }
    if (promptGeneratorStructure  !== undefined) { sets.push('prompt_generator_structure=?');   vals.push(promptGeneratorStructure) }
    if (promptGeneratorConditions !== undefined) { sets.push('prompt_generator_conditions=?');  vals.push(promptGeneratorConditions) }
    if (promptGeneratorMaxTokens  !== undefined) { sets.push('prompt_generator_max_tokens=?');  vals.push(parseInt(promptGeneratorMaxTokens) || 8000) }
    if (promptGeneratorTemperature !== undefined){ sets.push('prompt_generator_temperature=?'); vals.push(parseFloat(promptGeneratorTemperature)) }
    if (promptGeneratorMaxDocChars !== undefined){ sets.push('prompt_generator_max_doc_chars=?'); vals.push(parseInt(promptGeneratorMaxDocChars) || 200000) }
    if (promptGeneratorAllowFlows !== undefined) { sets.push('prompt_generator_allow_flows=?'); vals.push(promptGeneratorAllowFlows ? 1 : 0) }
    if (promptGeneratorMaxFileMb  !== undefined) {
      const n = parseInt(promptGeneratorMaxFileMb) || 30
      // Hard cap at 100 MB (same as media — matches the multer ceiling)
      sets.push('prompt_generator_max_file_mb=?'); vals.push(Math.max(1, Math.min(100, n)))
    }
    if (defaultPromptProvider     !== undefined) { sets.push('default_prompt_provider=?');      vals.push(String(defaultPromptProvider || 'deepseek')) }
    if (defaultPromptModel        !== undefined) { sets.push('default_prompt_model=?');         vals.push(String(defaultPromptModel || 'deepseek-v4-flash')) }
    if (optimizerModel            !== undefined) { sets.push('optimizer_model=?');               vals.push(String(optimizerModel || 'gpt-4o-mini')) }
    if (platformOpenaiKey         !== undefined) { sets.push('openai_key=?');                   vals.push(platformOpenaiKey) }
    if (platformDeepseekKey       !== undefined) { sets.push('deepseek_key=?');                 vals.push(platformDeepseekKey) }
    if (platformAnthropicKey      !== undefined) { sets.push('anthropic_key=?');                vals.push(platformAnthropicKey) }
    if (mediaMaxSizeMb            !== undefined) {
      const n = parseInt(mediaMaxSizeMb) || 30
      // Hard cap at 100 MB to match the multer ceiling
      sets.push('media_max_size_mb=?'); vals.push(Math.max(1, Math.min(100, n)))
    }
    if (transcriptionModel        !== undefined) {
      const allowed = ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe']
      sets.push('transcription_model=?'); vals.push(allowed.includes(transcriptionModel) ? transcriptionModel : 'whisper-1')
    }
    if (sets.length) { vals.push(1); await pool.query(`UPDATE platform_settings SET ${sets.join(',')} WHERE id=?`, vals) }
    res.json({ ok: true })
  } catch (err) { console.error('[PUT SETTINGS]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Public endpoint — returns only safe/public platform fields (no auth required)
const getPublicIntegrations = async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT meta_app_id, meta_config_id, media_max_size_mb FROM platform_settings WHERE id=1')
    res.json({
      metaAppId: r?.meta_app_id || '',
      metaConfigId: r?.meta_config_id || '',
      mediaMaxSizeMb: r?.media_max_size_mb || 30,
    })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Super admin ───────────────────────────────────────────────────────────────

const listSuperAdmins = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    const [rows] = await pool.query('SELECT id, name, email FROM super_admins ORDER BY name ASC')
    res.json(rows)
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const createSuperAdmin = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { name, email, password } = req.body
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' })
  const id = 'sa_' + uid()
  try {
    await pool.query('INSERT INTO super_admins (id, name, email, password) VALUES (?, ?, ?, ?)', [id, name, email, password])
    res.json({ id, name, email })
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un Super Admin con ese email' })
    console.error('[POST SA]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const updateSuperAdmin = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { saId } = req.params
  const { name, email, password } = req.body
  try {
    const sets = []; const vals = []
    if (name  !== undefined) { sets.push('name=?');  vals.push(name) }
    if (email !== undefined) { sets.push('email=?'); vals.push(email) }
    if (password)            { sets.push('password=?'); vals.push(password) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(saId)
    await pool.query(`UPDATE super_admins SET ${sets.join(',')} WHERE id=?`, vals)
    res.json({ ok: true })
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un Super Admin con ese email' })
    console.error('[PUT SA]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const deleteSuperAdmin = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { saId } = req.params
  if (saId === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' })
  try {
    const [[sa]] = await pool.query('SELECT id FROM super_admins WHERE id=?', [saId])
    if (!sa) return res.status(404).json({ error: 'Super Admin no encontrado' })
    await pool.query('DELETE FROM super_admins WHERE id=?', [saId])
    res.json({ ok: true })
  } catch (err) { console.error('[DELETE SA]', err); res.status(500).json({ error: 'Error interno' }) }
}

const listAllUsers = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    const [rows] = await pool.query(`
      SELECT m.id, m.name, m.email, m.role_id, m.status,
             a.id AS accountId, a.name AS accountName,
             r.name AS roleName
      FROM members m
      JOIN accounts a ON m.account_id = a.id
      LEFT JOIN roles r ON m.role_id = r.id
      ORDER BY a.name ASC, m.name ASC
    `)
    res.json(rows.map(r => ({
      id: r.id, name: r.name, email: r.email,
      roleId: r.role_id, roleName: r.roleName,
      status: r.status, accountId: r.accountId, accountName: r.accountName,
    })))
  } catch (err) { console.error('[LIST USERS]', err); res.status(500).json({ error: 'Error interno' }) }
}

const listAccounts = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    const [accounts] = await pool.query('SELECT * FROM accounts ORDER BY created_at DESC')
    const [agents]   = await pool.query('SELECT id, account_id, name, status, model, prompts, channels FROM agents')
    const [members]  = await pool.query('SELECT id, account_id, name, email, role_id, status FROM members')
    const agByAcc = {}; const memByAcc = {}
    for (const ag of agents)  { if (!agByAcc[ag.account_id])  agByAcc[ag.account_id]  = []; agByAcc[ag.account_id].push(ag) }
    for (const m  of members) { if (!memByAcc[m.account_id]) memByAcc[m.account_id] = []; memByAcc[m.account_id].push(m) }
    // Fetch monthly usage for each account
    const month = new Date().toISOString().slice(0, 7)
    const [usages] = await pool.query('SELECT * FROM change_agent_usage WHERE month=?', [month])
    const usageByAcc = {}
    for (const u of usages) {
      usageByAcc[u.account_id] = {
        used: u.used || 0,
        basicUsed: u.basic_used || 0,
        mediumUsed: u.medium_used || 0,
        complexUsed: u.complex_used || 0,
      }
    }
    res.json(accounts.map(a => ({
      id: a.id, name: a.name, email: a.email, plan: a.plan, status: a.status,
      modules: parseJ(a.modules, null),
      cmsStorageQuotaMb: a.cms_storage_quota_mb ?? null,
      channelLimitsOverride: parseJ(a.channel_limits_override, {}),
      changeAgentLimitOverride: a.change_agent_limit_override ?? null,
      changeAgentTokenLimitsOverride: parseJ(a.change_agent_token_limits_override, null),
      changeAgentUsage: usageByAcc[a.id]
        ? [{ month, ...usageByAcc[a.id] }]
        : [],
      agents: (agByAcc[a.id] || []).map(ag => ({
        id: ag.id, name: ag.name, status: ag.status, model: ag.model,
        channels: parseJ(ag.channels, []),
        prompts: parseJ(ag.prompts, []),
        rag: { enabled: false, files: [] }, aiToolIds: [],
      })),
      members: memByAcc[a.id] || [],
      createdAt: a.created_at,
    })))
  } catch (err) { console.error('[SA ACCOUNTS]', err); res.status(500).json({ error: 'Error interno' }) }
}

const createAccount = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  // Acepta JSON o multipart (cuando se sube un documento para generar el prompt).
  const { name, email, plan = 'free', agentName = '', observations = '' } = req.body
  const id = 'acc_' + uid()
  try {
    await pool.query(
      'INSERT INTO accounts (id,name,email,plan,status,channel_limits_override) VALUES (?,?,?,?,?,?)',
      [id, name, email, plan, 'active', '{"webchat":null,"test":null,"whatsapp":null,"messenger":null,"instagram":null}']
    )
    const ownerRoleId = 'role_owner_' + uid()
    await pool.query(
      'INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,1,?)',
      [ownerRoleId, id, 'Owner', '{"inbox":true,"agents":true,"channels":true,"crm":true,"pipeline":true,"config":true,"admins":true,"flows":true,"variables":true,"tools":true,"knowledge":true}']
    )
    await pool.query(
      'INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,0,?)',
      ['role_agent_' + uid(), id, 'Agente', '{"inbox":true,"agents":false,"channels":false,"crm":true,"pipeline":true,"config":false,"admins":false,"flows":false,"variables":false,"tools":false,"knowledge":false}']
    )

    // Deja la cuenta lista: agente + prompt (generador) + flujo de respuesta +
    // variable {{respuesta_ia}}. Best-effort: si falla, la cuenta igual se crea.
    try {
      const docText = req.file ? await extractFileText(req.file) : ''
      await provisionDefaultAgent(id, { agentName, companyName: name, observations, docText })
    } catch (provErr) {
      console.error('[POST ACCOUNT SA] provisión por defecto falló (cuenta creada igual):', provErr.message)
    }

    res.json({ id })
  } catch (err) {
    console.error('[POST ACCOUNT SA]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const updateSAAccount = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { accId } = req.params
  const { plan, status, channelLimitsOverride, changeAgentLimitOverride, changeAgentTokenLimitsOverride, modules, cmsStorageQuotaMb } = req.body
  try {
    const sets = []; const vals = []
    if (plan                     !== undefined) { sets.push('plan=?');                      vals.push(plan) }
    if (status                   !== undefined) { sets.push('status=?');                    vals.push(status) }
    // Override de almacenamiento del CMS (plan "personalizado"): MB, o null = usar el plan.
    if (cmsStorageQuotaMb        !== undefined) { sets.push('cms_storage_quota_mb=?');      vals.push(cmsStorageQuotaMb === null || cmsStorageQuotaMb === '' ? null : Number(cmsStorageQuotaMb)) }
    if (channelLimitsOverride    !== undefined) { sets.push('channel_limits_override=?');   vals.push(JSON.stringify(channelLimitsOverride)) }
    // Módulos override por cuenta: array de ids habilitados, o null = heredar del tipo / todos.
    if (modules                  !== undefined) { sets.push('modules=?');                   vals.push(Array.isArray(modules) ? JSON.stringify(modules) : null) }
    if (changeAgentLimitOverride !== undefined) { sets.push('change_agent_limit_override=?'); vals.push(changeAgentLimitOverride) }
    if (changeAgentTokenLimitsOverride !== undefined) {
      sets.push('change_agent_token_limits_override=?')
      vals.push(changeAgentTokenLimitsOverride === null ? null : JSON.stringify(changeAgentTokenLimitsOverride))
    }
    if (sets.length) { vals.push(accId); await pool.query(`UPDATE accounts SET ${sets.join(',')} WHERE id=?`, vals) }
    res.json({ ok: true })
  } catch (err) { console.error('[PUT SA ACCOUNT]', err); res.status(500).json({ error: 'Error interno' }) }
}

const deleteAccount = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    await pool.query('DELETE FROM accounts WHERE id=?', [req.params.accId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { getSettings, updateSettings, getPublicIntegrations, listSuperAdmins, createSuperAdmin, updateSuperAdmin, deleteSuperAdmin, listAllUsers, listAccounts, createAccount, updateSAAccount, deleteAccount }
