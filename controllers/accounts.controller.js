'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { parseJ, uid } = require('../utils')
const modulesSvc = require('../services/modules')

// Módulos efectivos de una cuenta: override de la cuenta → preset del tipo → todos.
async function effectiveModules(accId, accModulesRaw) {
  let typeModules = null
  try {
    const [[sub]] = await pool.query('SELECT account_type_id FROM account_subscriptions WHERE account_id=?', [accId])
    if (sub?.account_type_id) {
      const [[t]] = await pool.query('SELECT modules FROM account_types WHERE id=?', [sub.account_type_id])
      typeModules = t?.modules ?? null
    }
  } catch { /* sin suscripción → solo override de cuenta o todos */ }
  return modulesSvc.resolveModules(accModulesRaw, typeModules)
}

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

// Herramienta IA Especial de la TIENDA WooCommerce. Solo se ofrece cuando la
// cuenta tiene la conexión configurada (accounts.woocommerce.enabled). Al
// asignarla a un prompt, el asistente puede buscar productos, enviarlos con
// fotos, crear pedidos con link de pago y confirmar el pago.
const SPECIAL_WOO_TOOL = {
  id: 'woo_store',
  name: 'tienda',
  description: 'Tienda conectada (WooCommerce o Shopify): busca productos y responde sobre precios/características, envía productos con sus fotos, crea pedidos y envía el link de pago (el pago se confirma solo). Asígnala a un prompt para habilitarla.',
  collectFields: [],
  actionType: 'woocommerce',
  special: true,
}
const storeSvc = require('../services/store')
const schedulingSvc = require('../services/scheduling')
// La herramienta de la tienda SIEMPRE está disponible para asignar a un prompt
// (igual que la del CMS). Se "activa" al asignarla; en runtime solo responde si
// la tienda está conectada (Woo/Shopify) en la pestaña Tienda.
const wooTools = () => [SPECIAL_WOO_TOOL]

// Herramienta IA Especial de AGENDA (siempre asignable; opera solo si el cliente
// eligió calendarios en Zona IA → Agenda).
const SPECIAL_AGENDA_TOOL = {
  id: 'agenda',
  name: 'agenda',
  description: 'Agenda de citas: el asistente puede ver disponibilidad, recomendar horarios, agendar, mover y cancelar citas en los calendarios que el cliente habilitó. Asígnala a un prompt para habilitarla.',
  collectFields: [],
  actionType: 'scheduling',
  special: true,
}
const paymentsSvc = require('../services/payments')
// Herramienta IA Especial de PAGOS (siempre asignable; opera solo si la cuenta
// conectó una pasarela en Zona IA → Pasarela de pago). El asistente puede generar
// links de pago y consultar si un pago se completó.
const SPECIAL_PAYMENT_TOOL = {
  id: 'pasarela_pago',
  name: 'pasarela_pago',
  description: 'Pasarela de pago (Wompi …): el asistente genera links de pago y detecta si un pago se realizó. Al confirmarse el pago se dispara el flujo configurado. Asígnala a un prompt para habilitarla.',
  collectFields: [],
  actionType: 'payment',
  special: true,
}
// Herramienta IA Especial de CATÁLOGO DE META (siempre asignable; opera solo si
// la cuenta conectó un catálogo en Configuración → Catálogo Meta). El asistente
// puede responder sobre el catálogo, enviar productos con foto, enviar el catálogo
// completo y generar pedidos (con link de pago si hay pasarela conectada).
const SPECIAL_CATALOG_TOOL = {
  id: 'meta_catalog',
  name: 'catalogo',
  description: 'Catálogo de Meta conectado: busca productos y responde sobre precios/características, envía productos con su foto, envía el catálogo completo y genera pedidos. Asígnala a un prompt para habilitarla.',
  collectFields: [],
  actionType: 'meta_catalog',
  special: true,
}
// Herramienta IA Especial de PMS HOTELERO (HosRoom/Kunas). Siempre asignable;
// opera solo si la cuenta conectó su PMS en Zona IA → PMS. El asistente puede
// mostrar habitaciones con fotos reales, consultar disponibilidad con precios,
// reservar (con link de pago), ver el estado de una reserva y gestionar
// solicitudes de reagenda/cancelación.
const SPECIAL_PMS_TOOL = {
  id: 'pms_hotel',
  name: 'pms',
  description: 'PMS hotelero conectado (HosRoom/Kunas): el asistente muestra habitaciones con fotos reales, consulta disponibilidad con precios y cotización, crea reservas con link de pago, hace seguimiento por código y registra solicitudes de reagenda/cancelación para el equipo. Asígnala a un prompt para habilitarla.',
  collectFields: [],
  actionType: 'pms',
  special: true,
}
const pmsSvc = require('../services/pms')
// Herramienta IA Especial "pedidos": el asistente muestra el menú (con fotos),
// arma el pedido, captura tipo de entrega y datos, calcula totales + envío por
// zona, genera el pago (link o contra entrega) y hace seguimiento por código.
const SPECIAL_ORDERS_TOOL = {
  id: 'orders_local',
  name: 'pedidos',
  description: 'Pedidos y domicilios: el asistente muestra el menú con precios y fotos, arma el pedido (carrito), captura el tipo de entrega (domicilio/recoger/en el local/programado) y los datos, calcula el total con envío por zona, mínimos e impuestos, cobra en línea (link de pago) o contra entrega con vuelto, confirma el pedido con un código y hace seguimiento. Asígnala a un prompt para habilitarla.',
  collectFields: [],
  actionType: 'orders',
  special: true,
}
const ordersSvc = require('../services/orders')
const specialTools = () => [SPECIAL_WOO_TOOL, SPECIAL_AGENDA_TOOL, SPECIAL_PAYMENT_TOOL, SPECIAL_CATALOG_TOOL, SPECIAL_PMS_TOOL, SPECIAL_ORDERS_TOOL]

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
  const [[pf]] = await pool.query('SELECT openai_key, deepseek_key, anthropic_key, default_prompt_provider, default_prompt_model FROM platform_settings WHERE id=1')
  const effOpenai    = (acc.openai_key    && acc.openai_key.trim())    || pf?.openai_key    || ''
  const effDeepseek  = (acc.deepseek_key  && acc.deepseek_key.trim())  || pf?.deepseek_key  || ''
  const effAnthropic = (acc.anthropic_key && acc.anthropic_key.trim()) || pf?.anthropic_key || ''
  const schedulingCfg = await schedulingSvc.publicConfig(accId).catch(() => ({ connected: false }))
  const modules = await effectiveModules(accId, acc.modules)
  const _mc = parseJ(acc.meta_catalog, null)
  return {
    id: acc.id, name: acc.name, nickname: acc.nickname || acc.name,
    chatTheme: parseJ(acc.chat_theme, null),
    modules,
    metaCatalog: _mc?.catalogId ? { connected: true, catalogId: _mc.catalogId, name: _mc.name || _mc.catalogId } : { connected: false },
    openaiKey: effOpenai, deepseekKey: effDeepseek, anthropicKey: effAnthropic,
    agents: agents.map(mapAgent),
    variables: variables.map(v => ({ id: v.id, name: v.name, type: v.type, defaultValue: v.default_value, description: v.description, isSystem: !!v.is_system })),
    aiTools:   [SPECIAL_CMS_TOOL, ...specialTools(), ...aiTools.map(t => ({ id: t.id, name: t.name, description: t.description, collectFields: parseJ(t.collect_fields, []), flowId: t.flow_id, actionType: t.action_type || 'variable' }))],
    woocommerce: storeSvc.publicConfig(parseJ(acc.woocommerce, null)),
    scheduling: schedulingCfg,
    pms: pmsSvc.publicConfig(parseJ(acc.pms, null)),
    orders: await ordersSvc.publicConfigAsync(accId).catch(() => ({ connected: false })),
    // Conciencia temporal de la IA (zona horaria + fecha/hora base opcional).
    aiTimezone: acc.ai_timezone || 'America/Lima',
    aiDatetimeEnabled: acc.ai_datetime_enabled == null ? true : !!acc.ai_datetime_enabled,
    aiBaseDatetime: acc.ai_base_datetime || '',
    payments: paymentsSvc.publicConfig(parseJ(acc.payments, null)),
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
    const [[pf]] = await pool.query('SELECT openai_key, deepseek_key, anthropic_key, default_prompt_provider, default_prompt_model FROM platform_settings WHERE id=1')
    const effOpenai    = (acc.openai_key    && acc.openai_key.trim())    || pf?.openai_key    || ''
    const effDeepseek  = (acc.deepseek_key  && acc.deepseek_key.trim())  || pf?.deepseek_key  || ''
    const effAnthropic = (acc.anthropic_key && acc.anthropic_key.trim()) || pf?.anthropic_key || ''
    const schedulingCfg = await schedulingSvc.publicConfig(accId).catch(() => ({ connected: false }))
    const modules = await effectiveModules(accId, acc.modules)
    // Catálogo Meta: solo estado público (nunca el token).
    const mc = parseJ(acc.meta_catalog, null)
    const metaCatalog = mc?.catalogId ? { connected: true, catalogId: mc.catalogId, name: mc.name || mc.catalogId, connectedAt: mc.connectedAt || null } : { connected: false }
    res.json({
      id: acc.id, name: acc.name, email: acc.email, plan: acc.plan, status: acc.status, createdAt: acc.created_at,
      modules, metaCatalog,
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
      changeAgentTokenQuota: acc.change_agent_token_quota ?? null,
      changeAgentUsage: usageRows.map(u => ({
        month: u.month,
        used: u.used,
        tokensUsed: Number(u.tokens_used || 0) || ((u.basic_used || 0) + (u.medium_used || 0) + (u.complex_used || 0)),
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
      aiTools:   [SPECIAL_CMS_TOOL, ...specialTools(), ...aiTools.map(t => ({ id: t.id, name: t.name, description: t.description, collectFields: parseJ(t.collect_fields, []), flowId: t.flow_id, actionType: t.action_type || 'variable', createdAt: t.created_at }))],
      woocommerce: storeSvc.publicConfig(parseJ(acc.woocommerce, null)),
      scheduling: schedulingCfg,
      pms: pmsSvc.publicConfig(parseJ(acc.pms, null)),
      orders: await ordersSvc.publicConfigAsync(accId).catch(() => ({ connected: false })),
      aiTimezone: acc.ai_timezone || 'America/Lima',
      aiDatetimeEnabled: acc.ai_datetime_enabled == null ? true : !!acc.ai_datetime_enabled,
      aiBaseDatetime: acc.ai_base_datetime || '',
      payments: paymentsSvc.publicConfig(parseJ(acc.payments, null)),
      // Modelo por defecto para prompts nuevos (lo fija el super admin). El owner
      // y demás usuarios no pueden cambiar el modelo; solo lo ve/edita el super admin.
      defaultPromptProvider: pf?.default_prompt_provider || 'deepseek',
      defaultPromptModel: pf?.default_prompt_model || 'deepseek-v4-flash',
      cmsAssets: cmsAssets.map(mapCmsAsset),
      cmsFolders: cmsFolders.map(mapCmsFolder),
      cmsTags: cmsTags.map(mapNamed),
      cmsCategories: cmsCategories.map(mapNamed),
      stickers: stickers.map(mapSticker),
      flows:     flows.map(f => ({ id: f.id, name: f.name, trigger: f.trigger, startNodeId: f.start_node_id, nodes: parseJ(f.nodes, []), createdAt: f.created_at })),
      contacts:  contacts.map(c => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, ...parseJ(c.extra, {}), createdAt: c.created_at })),
      calendars: calendars.map(c => ({
        id: c.id, type: c.type || 'booking', vertical: c.vertical || 'appointment',
        name: c.name, description: c.description || '',
        timezone: c.timezone, color: c.color, status: c.status,
        availability: parseJ(c.availability, {}), exceptions: parseJ(c.exceptions, []),
        appointment: parseJ(c.appointment, {}), formConfig: parseJ(c.form_config, {}),
        notifications: parseJ(c.notifications, {}), integrations: parseJ(c.integrations, {}),
        flowId: c.flow_id || null, sharedGroup: c.shared_group || '',
        createdAt: c.created_at, updatedAt: c.updated_at,
      })),
    })
  } catch (err) {
    console.error('[GET ACCOUNT]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const updateAccount = async (req, res) => {
  const { accId } = req.params
  const { openaiKey, deepseekKey, anthropicKey, name, email, plan, status, channelLimitsOverride, changeAgentLimitOverride, changeAgentTokenLimitsOverride, chatTheme, aiTimezone, aiDatetimeEnabled, aiBaseDatetime } = req.body
  try {
    const sets = []; const vals = []
    if (chatTheme               !== undefined) { sets.push('chat_theme=?');                vals.push(chatTheme === null ? null : JSON.stringify(chatTheme)) }
    if (aiTimezone              !== undefined) { sets.push('ai_timezone=?');               vals.push(String(aiTimezone || 'America/Lima').slice(0, 64)) }
    if (aiDatetimeEnabled       !== undefined) { sets.push('ai_datetime_enabled=?');       vals.push(aiDatetimeEnabled ? 1 : 0) }
    if (aiBaseDatetime          !== undefined) { sets.push('ai_base_datetime=?');          vals.push(aiBaseDatetime ? String(aiBaseDatetime).slice(0, 40) : null) }
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
    // Cambio de nombre: registrar historial y, si el apodo está vacío, fijarlo al
    // primer nombre (el que tenía antes de este cambio) para que no cambie luego.
    if (name !== undefined) {
      const [[cur]] = await pool.query('SELECT name, nickname FROM accounts WHERE id=?', [accId])
      if (cur && cur.name !== name) {
        await pool.query('INSERT INTO account_name_history (id,account_id,old_name,new_name,changed_by,changed_at) VALUES (?,?,?,?,?,?)',
          ['anh_' + uid(), accId, cur.name || '', name || '', req.user?.name || req.user?.email || 'Usuario', Date.now()]).catch(() => {})
        if (!cur.nickname) { sets.push('nickname=?'); vals.push(cur.name || name) }
      }
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
    const [[row]] = await pool.query('SELECT used, tokens_used, basic_used, medium_used, complex_used FROM change_agent_usage WHERE account_id=? AND month=?', [req.params.accId, month])
    const total = Number(row?.tokens_used || 0) || ((row?.basic_used || 0) + (row?.medium_used || 0) + (row?.complex_used || 0))
    res.json({ used: row?.used || 0, tokensUsed: total })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Un SOLO pool de tokens totales (sin tipos). body: { tokens: number }
const incrementChangeAgentUsage = async (req, res) => {
  const { accId } = req.params
  const { tokens = 0 } = req.body || {}
  const month = new Date().toISOString().slice(0, 7)
  const tokInc = Math.max(0, parseInt(tokens) || 0)
  try {
    await pool.query(
      `INSERT INTO change_agent_usage (account_id, month, used, tokens_used)
       VALUES (?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE used = used + 1, tokens_used = COALESCE(tokens_used,0) + ?`,
      [accId, month, tokInc, tokInc]
    )
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
    const [[pf]] = await pool.query('SELECT openai_key, deepseek_key, anthropic_key, default_prompt_provider, default_prompt_model FROM platform_settings WHERE id=1')

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
