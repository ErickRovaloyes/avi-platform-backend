'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { parseJ } = require('../utils')

const mapAgent = a => ({
  id: a.id, name: a.name, status: a.status,
  systemPrompt: a.system_prompt, model: a.model, welcomeMessage: a.welcome_message,
  prompts: parseJ(a.prompts, []), channels: parseJ(a.channels, []),
  rag: parseJ(a.rag, { enabled: false, files: [] }),
  aiToolIds: parseJ(a.ai_tool_ids, []),
  fallbackFlowId: a.fallback_flow_id || null,
  testFlowId: a.test_flow_id || null,
  links: parseJ(a.channels, []).filter(c => c.type === 'webchat').map(c => ({ id: c.id, label: c.name, createdAt: c.createdAt })),
})

// Recurso del CMS: archivo (imagen/documento) de la biblioteca de la cuenta que
// el asistente puede enviar en las conversaciones. media_id apunta a la tabla media.
// Herramienta IA Especial siempre disponible para asignar a un prompt: deja que
// el asistente envíe recursos del CMS. No es una fila real en ai_tools; se inyecta
// en la lista. El runtime la reconoce por actionType 'cms_resource'.
const SPECIAL_CMS_TOOL = {
  id: 'cms_send_resource',
  name: 'enviar_recurso',
  description: 'Envía imágenes o documentos del CMS al usuario (incluye carpetas de producto con varias fotos). Asígnala a un prompt para que el asistente pueda enviar recursos cuando sean relevantes.',
  collectFields: [],
  actionType: 'cms_resource',
  special: true,
}

const mapCmsAsset = c => ({
  id: c.id, name: c.name, description: c.description || '', tags: parseJ(c.tags, []),
  kind: c.kind, mediaId: c.media_id, filename: c.filename, mime: c.mime,
  sizeBytes: c.size_bytes, folderId: c.folder_id || null, category: c.category || '',
  ragFileId: c.rag_file_id || null, ragAgentId: c.rag_agent_id || null,
  createdAt: c.created_at,
})
const mapCmsFolder = f => ({ id: f.id, name: f.name, type: f.type || 'simple', description: f.description || '', createdAt: f.created_at })
const mapNamed = r => ({ id: r.id, name: r.name })
const mapSticker = s => ({ id: s.id, mediaId: s.media_id, mime: s.mime || 'image/webp', name: s.name || '', createdAt: s.created_at })

// Core: builds the public account object (agents, vars, tools, flows + effective
// keys). Reusable by the HTTP handler and by the server-side flow engine.
// Returns null when the account doesn't exist.
async function loadPublicAccount(accId) {
  const [[acc]] = await pool.query('SELECT * FROM accounts WHERE id=?', [accId])
  if (!acc) return null
  const [agents]    = await pool.query('SELECT * FROM agents WHERE account_id=?', [accId])
  const [variables] = await pool.query('SELECT * FROM variables WHERE account_id=?', [accId])
  const [aiTools]   = await pool.query('SELECT * FROM ai_tools WHERE account_id=?', [accId])
  const [cmsAssets] = await pool.query('SELECT * FROM cms_assets WHERE account_id=?', [accId])
  let cmsFolders = [], cmsTags = [], cmsCategories = [], stickers = []
  try { [cmsFolders]    = await pool.query('SELECT * FROM cms_folders WHERE account_id=?', [accId]) } catch { cmsFolders = [] }
  try { [cmsTags]       = await pool.query('SELECT * FROM cms_tags WHERE account_id=?', [accId]) } catch { cmsTags = [] }
  try { [cmsCategories] = await pool.query('SELECT * FROM cms_categories WHERE account_id=?', [accId]) } catch { cmsCategories = [] }
  try { [stickers]      = await pool.query('SELECT * FROM stickers WHERE account_id=? ORDER BY created_at DESC', [accId]) } catch { stickers = [] }
  const [flows]     = await pool.query('SELECT * FROM flows WHERE account_id=?', [accId])
  // Resolve API keys with super-admin platform fallback
  const [[pf]] = await pool.query('SELECT openai_key, deepseek_key, anthropic_key FROM platform_settings WHERE id=1')
  const effOpenai    = (acc.openai_key    && acc.openai_key.trim())    || pf?.openai_key    || ''
  const effDeepseek  = (acc.deepseek_key  && acc.deepseek_key.trim())  || pf?.deepseek_key  || ''
  const effAnthropic = (acc.anthropic_key && acc.anthropic_key.trim()) || pf?.anthropic_key || ''
  return {
    id: acc.id, name: acc.name,
    openaiKey: effOpenai, deepseekKey: effDeepseek, anthropicKey: effAnthropic,
    agents: agents.map(mapAgent),
    variables: variables.map(v => ({ id: v.id, name: v.name, type: v.type, defaultValue: v.default_value, description: v.description, isSystem: !!v.is_system })),
    aiTools:   [SPECIAL_CMS_TOOL, ...aiTools.map(t => ({ id: t.id, name: t.name, description: t.description, collectFields: parseJ(t.collect_fields, []), flowId: t.flow_id, actionType: t.action_type || 'variable' }))],
    cmsAssets: cmsAssets.map(mapCmsAsset),
    cmsFolders: cmsFolders.map(mapCmsFolder),
    cmsTags: cmsTags.map(mapNamed),
    cmsCategories: cmsCategories.map(mapNamed),
    stickers: stickers.map(mapSticker),
    flows:     flows.map(f => ({ id: f.id, name: f.name, trigger: f.trigger, startNodeId: f.start_node_id, nodes: parseJ(f.nodes, []) })),
  }
}

// Public (no auth) — returns only data needed by webchat
const getPublicAccount = async (req, res) => {
  const { accId } = req.params
  try {
    const data = await loadPublicAccount(accId)
    if (!data) return res.status(404).json({ error: 'Cuenta no encontrada' })
    res.json(data)
  } catch (err) {
    console.error('[GET PUBLIC ACCOUNT]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const getAccount = async (req, res) => {
  const { accId } = req.params
  try {
    const [[acc]] = await pool.query('SELECT * FROM accounts WHERE id=?', [accId])
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' })
    const [agents]    = await pool.query('SELECT * FROM agents WHERE account_id=?', [accId])
    const [members]   = await pool.query('SELECT * FROM members WHERE account_id=?', [accId])
    const [roles]     = await pool.query('SELECT * FROM roles WHERE account_id=?', [accId])
    const [labels]    = await pool.query('SELECT * FROM labels WHERE account_id=?', [accId])
    const [pipelines] = await pool.query('SELECT * FROM pipelines WHERE account_id=?', [accId])
    const [variables] = await pool.query('SELECT * FROM variables WHERE account_id=?', [accId])
    const [aiTools]   = await pool.query('SELECT * FROM ai_tools WHERE account_id=?', [accId])
    const [cmsAssets] = await pool.query('SELECT * FROM cms_assets WHERE account_id=?', [accId])
    let cmsFolders = [], cmsTags = [], cmsCategories = [], stickers = []
    try { [cmsFolders]    = await pool.query('SELECT * FROM cms_folders WHERE account_id=? ORDER BY created_at', [accId]) } catch { cmsFolders = [] }
    try { [cmsTags]       = await pool.query('SELECT * FROM cms_tags WHERE account_id=? ORDER BY name', [accId]) } catch { cmsTags = [] }
    try { [cmsCategories] = await pool.query('SELECT * FROM cms_categories WHERE account_id=? ORDER BY name', [accId]) } catch { cmsCategories = [] }
    try { [stickers]      = await pool.query('SELECT * FROM stickers WHERE account_id=? ORDER BY created_at DESC', [accId]) } catch { stickers = [] }
    const [flows]     = await pool.query('SELECT * FROM flows WHERE account_id=?', [accId])
    const [contacts]  = await pool.query('SELECT * FROM contacts WHERE account_id=?', [accId])
    const [usageRows] = await pool.query('SELECT * FROM change_agent_usage WHERE account_id=?', [accId])
    // Calendarios (tabla creada por migración en arranque — defensivo por si aún no existe)
    let calendars = []
    try { [calendars] = await pool.query('SELECT * FROM calendars WHERE account_id=? ORDER BY created_at DESC', [accId]) } catch { calendars = [] }
    // Effective keys (account own → platform fallback). UI shows badge per provider.
    const [[pf]] = await pool.query('SELECT openai_key, deepseek_key, anthropic_key FROM platform_settings WHERE id=1')
    const effOpenai    = (acc.openai_key    && acc.openai_key.trim())    || pf?.openai_key    || ''
    const effDeepseek  = (acc.deepseek_key  && acc.deepseek_key.trim())  || pf?.deepseek_key  || ''
    const effAnthropic = (acc.anthropic_key && acc.anthropic_key.trim()) || pf?.anthropic_key || ''
    res.json({
      id: acc.id, name: acc.name, email: acc.email, plan: acc.plan, status: acc.status,
      // Own keys (user-settable in Settings); read-only effective ones below
      openaiKeyOwn:    acc.openai_key    || '',
      deepseekKeyOwn:  acc.deepseek_key  || '',
      anthropicKeyOwn: acc.anthropic_key || '',
      // Effective (used by the AI client) — account own first, platform fallback otherwise
      openaiKey: effOpenai, deepseekKey: effDeepseek, anthropicKey: effAnthropic,
      // Indicate whether the effective key is the platform default
      openaiKeySource:    (acc.openai_key    && acc.openai_key.trim())    ? 'account' : (pf?.openai_key    ? 'platform' : 'none'),
      deepseekKeySource:  (acc.deepseek_key  && acc.deepseek_key.trim())  ? 'account' : (pf?.deepseek_key  ? 'platform' : 'none'),
      anthropicKeySource: (acc.anthropic_key && acc.anthropic_key.trim()) ? 'account' : (pf?.anthropic_key ? 'platform' : 'none'),
      channelLimitsOverride: parseJ(acc.channel_limits_override, {}),
      changeAgentLimitOverride: acc.change_agent_limit_override,
      changeAgentTokenLimitsOverride: parseJ(acc.change_agent_token_limits_override, null),
      changeAgentUsage: usageRows.map(u => ({
        month: u.month,
        used: u.used,
        basicUsed: u.basic_used || 0,
        mediumUsed: u.medium_used || 0,
        complexUsed: u.complex_used || 0,
      })),
      roles:     roles.map(r => ({ id: r.id, name: r.name, isSystem: !!r.is_system, permissions: parseJ(r.permissions, {}) })),
      members:   members.map(m => ({ id: m.id, name: m.name, email: m.email, avatar: m.avatar, roleId: m.role_id, agentAccess: parseJ(m.agent_access, []), status: m.status })),
      agents:    agents.map(a => ({ ...mapAgent(a), createdAt: a.created_at })),
      labels:    labels.map(l => ({ id: l.id, name: l.name, color: l.color })),
      pipelines: pipelines.map(p => ({ id: p.id, name: p.name, stages: parseJ(p.stages, []), cards: parseJ(p.cards, []) })),
      variables: variables.map(v => ({ id: v.id, name: v.name, type: v.type, defaultValue: v.default_value, description: v.description, isSystem: !!v.is_system })),
      aiTools:   [SPECIAL_CMS_TOOL, ...aiTools.map(t => ({ id: t.id, name: t.name, description: t.description, collectFields: parseJ(t.collect_fields, []), flowId: t.flow_id, actionType: t.action_type || 'variable', createdAt: t.created_at }))],
      cmsAssets: cmsAssets.map(mapCmsAsset),
      cmsFolders: cmsFolders.map(mapCmsFolder),
      cmsTags: cmsTags.map(mapNamed),
      cmsCategories: cmsCategories.map(mapNamed),
      stickers: stickers.map(mapSticker),
      flows:     flows.map(f => ({ id: f.id, name: f.name, trigger: f.trigger, startNodeId: f.start_node_id, nodes: parseJ(f.nodes, []), createdAt: f.created_at })),
      contacts:  contacts.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, ...parseJ(c.extra, {}), createdAt: c.created_at })),
      calendars: calendars.map(c => ({
        id: c.id, type: c.type || 'booking', name: c.name, description: c.description || '',
        timezone: c.timezone, color: c.color, status: c.status,
        availability: parseJ(c.availability, {}), exceptions: parseJ(c.exceptions, []),
        appointment: parseJ(c.appointment, {}), formConfig: parseJ(c.form_config, {}),
        notifications: parseJ(c.notifications, {}), integrations: parseJ(c.integrations, {}),
        flowId: c.flow_id || null, createdAt: c.created_at, updatedAt: c.updated_at,
      })),
    })
  } catch (err) {
    console.error('[GET ACCOUNT]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const updateAccount = async (req, res) => {
  const { accId } = req.params
  const { openaiKey, deepseekKey, anthropicKey, name, email, plan, status, channelLimitsOverride, changeAgentLimitOverride, changeAgentTokenLimitsOverride } = req.body
  try {
    const sets = []; const vals = []
    if (openaiKey               !== undefined) { sets.push('openai_key=?');                vals.push(openaiKey) }
    if (deepseekKey             !== undefined) { sets.push('deepseek_key=?');              vals.push(deepseekKey) }
    if (anthropicKey            !== undefined) { sets.push('anthropic_key=?');             vals.push(anthropicKey) }
    if (name                    !== undefined) { sets.push('name=?');                      vals.push(name) }
    if (email                   !== undefined) { sets.push('email=?');                     vals.push(email) }
    if (plan                    !== undefined) { sets.push('plan=?');                      vals.push(plan) }
    if (status                  !== undefined) { sets.push('status=?');                    vals.push(status) }
    if (channelLimitsOverride   !== undefined) { sets.push('channel_limits_override=?');   vals.push(JSON.stringify(channelLimitsOverride)) }
    if (changeAgentLimitOverride !== undefined) { sets.push('change_agent_limit_override=?'); vals.push(changeAgentLimitOverride) }
    if (changeAgentTokenLimitsOverride !== undefined) {
      sets.push('change_agent_token_limits_override=?')
      vals.push(changeAgentTokenLimitsOverride === null ? null : JSON.stringify(changeAgentTokenLimitsOverride))
    }
    if (!sets.length) return res.json({ ok: true })
    vals.push(accId)
    await pool.query(`UPDATE accounts SET ${sets.join(',')} WHERE id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[PUT ACCOUNT]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const getChangeAgentUsage = async (req, res) => {
  const month = new Date().toISOString().slice(0, 7)
  try {
    const [[row]] = await pool.query('SELECT used, basic_used, medium_used, complex_used FROM change_agent_usage WHERE account_id=? AND month=?', [req.params.accId, month])
    res.json({
      used: row?.used || 0,
      basicUsed: row?.basic_used || 0,
      mediumUsed: row?.medium_used || 0,
      complexUsed: row?.complex_used || 0,
    })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Increment usage for a given category and token amount
// body: { category: 'basic'|'medium'|'complex', tokens: number }
const incrementChangeAgentUsage = async (req, res) => {
  const { accId } = req.params
  const { category = null, tokens = 0 } = req.body || {}
  const month = new Date().toISOString().slice(0, 7)
  const validCat = ['basic', 'medium', 'complex'].includes(category) ? category : null
  const col = validCat ? `${validCat}_used` : null
  const tokInc = Math.max(0, parseInt(tokens) || 0)
  try {
    if (col) {
      await pool.query(
        `INSERT INTO change_agent_usage (account_id, month, used, ${col})
         VALUES (?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE used = used + 1, ${col} = ${col} + ?`,
        [accId, month, tokInc, tokInc]
      )
    } else {
      // Legacy fallback: just bump the global 'used' counter
      await pool.query(
        'INSERT INTO change_agent_usage (account_id,month,used) VALUES (?,?,1) ON DUPLICATE KEY UPDATE used=used+1',
        [accId, month]
      )
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[INC CA USAGE]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

// Returns the effective API key per provider for an account.
// Order: account-own key → platform default key. Indicates the source so the
// client can show "using platform key" badges. The actual key value is
// returned only for the providers the account has authenticated access to.
const getEffectiveKeys = async (req, res) => {
  const { accId } = req.params
  try {
    const [[acc]] = await pool.query('SELECT openai_key, deepseek_key, anthropic_key FROM accounts WHERE id=?', [accId])
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' })
    const [[pf]] = await pool.query('SELECT openai_key, deepseek_key, anthropic_key FROM platform_settings WHERE id=1')

    const pick = (own, platform) => {
      if (own && own.trim())               return { value: own,      source: 'account'  }
      if (platform && platform.trim())     return { value: platform, source: 'platform' }
      return { value: '', source: 'none' }
    }
    const openai    = pick(acc.openai_key,    pf?.openai_key)
    const deepseek  = pick(acc.deepseek_key,  pf?.deepseek_key)
    const anthropic = pick(acc.anthropic_key, pf?.anthropic_key)

    res.json({
      openai:    { key: openai.value,    source: openai.source },
      deepseek:  { key: deepseek.value,  source: deepseek.source },
      anthropic: { key: anthropic.value, source: anthropic.source },
    })
  } catch (err) {
    console.error('[EFFECTIVE KEYS]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

module.exports = { getPublicAccount, loadPublicAccount, getAccount, updateAccount, getChangeAgentUsage, incrementChangeAgentUsage, getEffectiveKeys }
