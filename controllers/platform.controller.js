'use strict'
const pool = require('../db')
const { uid, parseJ } = require('../utils')
const { provisionDefaultAgent, provisionStarterAgent } = require('../services/accountProvision')
const { extractFileText } = require('./promptGenerator.controller')
const { sendEmail, renderCodeEmail, DEFAULT_EMAIL_TEMPLATES } = require('../services/email')
const pw = require('../services/passwords')

// ── Platform settings ─────────────────────────────────────────────────────────

const DEFAULT_TOKEN_LIMITS = { basic: 50000, medium: 30000, complex: 15000 }
// Capacidades del Agente de Cambios activables por el super admin (qué puede modificar).
const DEFAULT_CA_CAPS = { prompt: true, tools: true, flows: true, agendas: true }
const parseCaps = raw => { const c = parseJ(raw, null); return c ? { ...DEFAULT_CA_CAPS, ...c } : { ...DEFAULT_CA_CAPS } }
// Aviso por defecto para la IA cuando escribe un cliente recurrente (ver ai.js).
// El super admin lo edita; cada cuenta puede sobrescribirlo por canal.
const DEFAULT_RETURNING_NOTICE = 'Esta persona YA había conversado con el negocio anteriormente; NO la trates como un contacto nuevo ni la saludes como si fuera la primera vez. Retoma el hilo con naturalidad.'
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
          changeAgentTokenLimit: r.change_agent_token_limit ?? 95000,
          changeAgentTokenLimits: parseJ(r.change_agent_token_limits, DEFAULT_TOKEN_LIMITS),
          changeAgentCaps: parseCaps(r.change_agent_caps),
          channelLimits: parseJ(r.channel_limits, {}),
          metaAppId: r.meta_app_id || '',
          metaConfigId: r.meta_config_id || '',
          metaPagesConfigId: r.meta_pages_config_id || '',
          // El App Secret solo lo ve el super admin; al resto se le indica si existe.
          metaAppSecret: isSA ? (r.meta_app_secret || '') : '',
          hasMetaAppSecret: !!r.meta_app_secret,
          // Instagram API con Instagram Login: producto aparte, credenciales propias.
          instagramAppId: r.instagram_app_id || '',
          instagramRedirectUri: r.instagram_redirect_uri || '',
          instagramAppSecret: isSA ? (r.instagram_app_secret || '') : '',
          hasInstagramAppSecret: !!r.instagram_app_secret,
          // Credenciales OAuth de Google (Calendar + Sheets). El secret solo lo ve el SA.
          googleClientId: r.google_client_id || '',
          googleClientSecret: isSA ? (r.google_client_secret || '') : '',
          hasGoogleClientSecret: !!r.google_client_secret,
          googleRedirectUri: r.google_redirect_uri || '',
          googleApiKey: r.google_api_key || '',   // developerKey del Google Picker
          // Octorate: credenciales de la aplicacion de partner, comunes a toda la plataforma.
          octorateClientId: r.octorate_client_id || '',
          octorateClientSecret: isSA ? (r.octorate_client_secret || '') : '',
          hasOctorateClientSecret: !!r.octorate_client_secret,
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
          hasPlatformOpenaiKey:    !!r.openai_key,
          hasPlatformDeepseekKey:  !!r.deepseek_key,
          mediaMaxSizeMb: r.media_max_size_mb || 30,
          transcriptionModel: r.transcription_model || 'whisper-1',
          defaultPromptProvider: r.default_prompt_provider || 'deepseek',
          defaultPromptModel: r.default_prompt_model || 'deepseek-v4-flash',
          returningNoticeDefault: r.returning_notice_default || DEFAULT_RETURNING_NOTICE,
          optimizerModel: r.optimizer_model || 'gpt-4o-mini',
          businessAiModel: r.business_ai_model || 'gpt-4o-mini',
          demoAdsEnabled: !!r.demo_ads_enabled,
          demoAdsHtml: r.demo_ads_html || '',
          emailProvider: r.email_provider || 'none',
          emailApiKey: maskKey(r.email_api_key || ''),
          hasEmailApiKey: !!r.email_api_key,
          emailFrom: r.email_from || '',
          emailFromName: r.email_from_name || 'AVI Asistente',
          // SMTP (correo corporativo). La contraseña solo indica si existe (no se expone).
          smtpHost: r.smtp_host || '',
          smtpPort: r.smtp_port || 587,
          smtpUser: r.smtp_user || '',
          hasSmtpPass: !!r.smtp_pass,
          smtpSecure: !!r.smtp_secure,
          signupVerifyEnabled: !!r.signup_verify_enabled,
          login2faEnabled: !!r.login_2fa_enabled,
          // Plantillas de correo (guardadas ∪ defaults) para el editor del Super Panel.
          // Se recorren los defaults en vez de nombrarlos uno a uno: así, al añadir una
          // plantilla nueva, el editor la recibe sin tener que tocar también esta línea.
          emailTemplates: Object.fromEntries(Object.keys(DEFAULT_EMAIL_TEMPLATES).map(k =>
            [k, { ...DEFAULT_EMAIL_TEMPLATES[k], ...(parseJ(r.email_templates, {})?.[k] || {}) }])),
          brandLogo: r.brand_logo || '',
          brandLogoLight: r.brand_logo_light || '',
          brandFavicon: r.brand_favicon || '',
          brandName: r.brand_name || '',
          // Pasarelas de cobro de la PLATAFORMA (suscripciones). Los secretos solo se
          // exponen como "hasX"; las llaves públicas sí (van al navegador para el checkout).
          wompiPublicKey: r.wompi_public_key || '',
          hasWompiPrivateKey: !!r.wompi_private_key,
          hasWompiEventsSecret: !!r.wompi_events_secret,
          wompiMode: r.wompi_mode || 'production',
          stripePublishableKey: r.stripe_publishable_key || '',
          hasStripeSecretKey: !!r.stripe_secret_key,
          hasStripeWebhookSecret: !!r.stripe_webhook_secret,
          fxUsdCop: r.fx_usd_cop != null ? Number(r.fx_usd_cop) : null,
          fxUpdatedAt: r.fx_updated_at || null,
        }
      : {
          changeAgentModel: 'gpt-4o-mini',
          changeAgentDefaultLimit: 20,
          changeAgentTokenLimit: 95000,
          changeAgentTokenLimits: DEFAULT_TOKEN_LIMITS,
          changeAgentCaps: { ...DEFAULT_CA_CAPS },
          channelLimits: {},
          metaAppId: '',
          metaConfigId: '',
          metaPagesConfigId: '',
          metaAppSecret: '',
          hasMetaAppSecret: false,
          googleClientId: '',
          octorateClientId: '',
          octorateClientSecret: '',
          googleClientSecret: '',
          hasGoogleClientSecret: false,
          googleRedirectUri: '',
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
          returningNoticeDefault: DEFAULT_RETURNING_NOTICE,
          optimizerModel: 'gpt-4o-mini',
          demoAdsEnabled: false,
          demoAdsHtml: '',
          emailProvider: 'none',
          emailApiKey: '',
          hasEmailApiKey: false,
          emailFrom: '',
          emailFromName: 'AVI Asistente',
          smtpHost: '', smtpPort: 587, smtpUser: '', hasSmtpPass: false, smtpSecure: false,
          signupVerifyEnabled: false,
          login2faEnabled: false,
          emailTemplates: { login: { ...DEFAULT_EMAIL_TEMPLATES.login }, signup: { ...DEFAULT_EMAIL_TEMPLATES.signup } },
          brandLogo: '', brandLogoLight: '', brandFavicon: '', brandName: '',
          wompiPublicKey: '', hasWompiPrivateKey: false, hasWompiEventsSecret: false, wompiMode: 'production',
          stripePublishableKey: '', hasStripeSecretKey: false, hasStripeWebhookSecret: false,
          fxUsdCop: null, fxUpdatedAt: null,
        })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateSettings = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const {
    changeAgentModel, changeAgentDefaultLimit, changeAgentTokenLimits, changeAgentTokenLimit, changeAgentCaps,
    channelLimits, metaAppId, metaConfigId, metaPagesConfigId, metaAppSecret,
    instagramAppId, instagramAppSecret, instagramRedirectUri,
    googleClientId, googleClientSecret, googleRedirectUri, googleApiKey,
    octorateClientId, octorateClientSecret,
    promptGeneratorModel, promptGeneratorStructure, promptGeneratorConditions,
    promptGeneratorMaxTokens, promptGeneratorTemperature, promptGeneratorMaxDocChars,
    promptGeneratorAllowFlows,
    promptGeneratorMaxFileMb,
    platformOpenaiKey, platformDeepseekKey,
    mediaMaxSizeMb, transcriptionModel,
    defaultPromptProvider, defaultPromptModel, optimizerModel, businessAiModel,
    returningNoticeDefault,
    demoAdsEnabled, demoAdsHtml,
    emailProvider, emailApiKey, emailFrom, emailFromName, signupVerifyEnabled, login2faEnabled, emailTemplates,
    smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure,
    brandLogo, brandLogoLight, brandFavicon, brandName,
    wompiPublicKey, wompiPrivateKey, wompiEventsSecret, wompiMode,
    stripePublishableKey, stripeSecretKey, stripeWebhookSecret,
  } = req.body
  try {
    const sets = []; const vals = []
    if (emailTemplates !== undefined) { sets.push('email_templates=?'); vals.push(JSON.stringify(emailTemplates || {})) }
    if (brandLogo      !== undefined) { sets.push('brand_logo=?');       vals.push(brandLogo || null) }
    if (brandLogoLight !== undefined) { sets.push('brand_logo_light=?'); vals.push(brandLogoLight || null) }
    if (brandFavicon   !== undefined) { sets.push('brand_favicon=?');    vals.push(brandFavicon || null) }
    if (brandName    !== undefined) { sets.push('brand_name=?');    vals.push(String(brandName || '').slice(0, 120) || null) }
    if (changeAgentModel          !== undefined) { sets.push('change_agent_model=?');           vals.push(changeAgentModel) }
    if (changeAgentDefaultLimit   !== undefined) { sets.push('change_agent_default_limit=?');   vals.push(changeAgentDefaultLimit) }
    if (changeAgentTokenLimits    !== undefined) { sets.push('change_agent_token_limits=?');    vals.push(JSON.stringify(changeAgentTokenLimits)) }
    if (changeAgentTokenLimit     !== undefined) { sets.push('change_agent_token_limit=?');     vals.push(changeAgentTokenLimit === null || changeAgentTokenLimit === '' ? 95000 : Number(changeAgentTokenLimit)) }
    if (changeAgentCaps           !== undefined) { sets.push('change_agent_caps=?');            vals.push(JSON.stringify({ ...DEFAULT_CA_CAPS, ...changeAgentCaps })) }
    if (channelLimits             !== undefined) { sets.push('channel_limits=?');               vals.push(JSON.stringify(channelLimits)) }
    if (metaAppId                 !== undefined) { sets.push('meta_app_id=?');                  vals.push(metaAppId) }
    if (metaConfigId              !== undefined) { sets.push('meta_config_id=?');               vals.push(metaConfigId) }
    if (metaPagesConfigId         !== undefined) { sets.push('meta_pages_config_id=?');         vals.push(String(metaPagesConfigId || '').trim()) }
    if (instagramAppId            !== undefined) { sets.push('instagram_app_id=?');            vals.push(String(instagramAppId || '').trim()) }
    if (instagramAppSecret        !== undefined) { sets.push('instagram_app_secret=?');        vals.push(String(instagramAppSecret || '').trim()) }
    if (instagramRedirectUri      !== undefined) { sets.push('instagram_redirect_uri=?');      vals.push(String(instagramRedirectUri || '').trim()) }
    if (returningNoticeDefault    !== undefined) { sets.push('returning_notice_default=?');     vals.push(String(returningNoticeDefault || '').slice(0, 4000)) }
    // Solo se actualiza el secret si llega un valor no vacío (evita borrarlo al guardar enmascarado)
    if (metaAppSecret             !== undefined && metaAppSecret !== '') { sets.push('meta_app_secret=?'); vals.push(metaAppSecret) }
    // Credenciales OAuth de Google (una sola app para Calendar + Sheets).
    if (octorateClientId          !== undefined) { sets.push('octorate_client_id=?');          vals.push(String(octorateClientId || '').trim()) }
    // El secreto vacio NO se guarda: asi 'dejar el campo en blanco' conserva el actual en vez
    // de borrarlo sin querer al tocar cualquier otro ajuste.
    if (octorateClientSecret      !== undefined && octorateClientSecret !== '') { sets.push('octorate_client_secret=?'); vals.push(String(octorateClientSecret).trim()) }
    if (googleClientId            !== undefined) { sets.push('google_client_id=?');            vals.push(String(googleClientId || '').trim()) }
    if (googleRedirectUri         !== undefined) { sets.push('google_redirect_uri=?');         vals.push(String(googleRedirectUri || '').trim()) }
    if (googleClientSecret        !== undefined && googleClientSecret !== '') { sets.push('google_client_secret=?'); vals.push(String(googleClientSecret).trim()) }
    if (googleApiKey              !== undefined) { sets.push('google_api_key=?');              vals.push(String(googleApiKey || '').trim()) }
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
    if (businessAiModel           !== undefined) { sets.push('business_ai_model=?');             vals.push(String(businessAiModel || 'gpt-4o-mini')) }
    if (demoAdsEnabled            !== undefined) { sets.push('demo_ads_enabled=?');              vals.push(demoAdsEnabled ? 1 : 0) }
    if (demoAdsHtml               !== undefined) { sets.push('demo_ads_html=?');                 vals.push(demoAdsHtml || null) }
    // Pasarelas de cobro de la plataforma (suscripciones). Las llaves públicas se guardan
    // siempre; los secretos solo si llega un valor no vacío/enmascarado (no borrar al guardar).
    if (wompiPublicKey            !== undefined) { sets.push('wompi_public_key=?');   vals.push(String(wompiPublicKey || '').trim() || null) }
    if (wompiMode                 !== undefined) { sets.push('wompi_mode=?');         vals.push(wompiMode === 'sandbox' ? 'sandbox' : 'production') }
    if (wompiPrivateKey           !== undefined && wompiPrivateKey && !wompiPrivateKey.includes('***')) { sets.push('wompi_private_key=?'); vals.push(String(wompiPrivateKey).trim()) }
    if (wompiEventsSecret         !== undefined && wompiEventsSecret && !wompiEventsSecret.includes('***')) { sets.push('wompi_events_secret=?'); vals.push(String(wompiEventsSecret).trim()) }
    if (stripePublishableKey      !== undefined) { sets.push('stripe_publishable_key=?'); vals.push(String(stripePublishableKey || '').trim() || null) }
    if (stripeSecretKey           !== undefined && stripeSecretKey && !stripeSecretKey.includes('***')) { sets.push('stripe_secret_key=?'); vals.push(String(stripeSecretKey).trim()) }
    if (stripeWebhookSecret       !== undefined && stripeWebhookSecret && !stripeWebhookSecret.includes('***')) { sets.push('stripe_webhook_secret=?'); vals.push(String(stripeWebhookSecret).trim()) }
    if (emailProvider             !== undefined) { sets.push('email_provider=?');                vals.push(String(emailProvider || 'none')) }
    // Solo se actualiza la API key si llega un valor no vacío y sin enmascarar (evita borrarla al guardar el placeholder).
    if (emailApiKey               !== undefined && emailApiKey !== '' && !emailApiKey.includes('***')) { sets.push('email_api_key=?'); vals.push(emailApiKey) }
    // SMTP (correo corporativo). La contraseña solo se actualiza si llega una nueva.
    if (smtpHost                  !== undefined) { sets.push('smtp_host=?'); vals.push(String(smtpHost || '').trim()) }
    if (smtpPort                  !== undefined) { sets.push('smtp_port=?'); vals.push(parseInt(smtpPort) || 587) }
    if (smtpUser                  !== undefined) { sets.push('smtp_user=?'); vals.push(String(smtpUser || '').trim()) }
    if (smtpSecure                !== undefined) { sets.push('smtp_secure=?'); vals.push(smtpSecure ? 1 : 0) }
    if (smtpPass                  !== undefined && smtpPass !== '' && !smtpPass.includes('***')) { sets.push('smtp_pass=?'); vals.push(smtpPass) }
    if (emailFrom                 !== undefined) { sets.push('email_from=?');                     vals.push(emailFrom || null) }
    if (emailFromName             !== undefined) { sets.push('email_from_name=?');                vals.push(emailFromName || 'AVI Asistente') }
    if (signupVerifyEnabled       !== undefined) { sets.push('signup_verify_enabled=?');         vals.push(signupVerifyEnabled ? 1 : 0) }
    if (login2faEnabled           !== undefined) { sets.push('login_2fa_enabled=?');             vals.push(login2faEnabled ? 1 : 0) }
    if (platformOpenaiKey         !== undefined) { sets.push('openai_key=?');                   vals.push(platformOpenaiKey) }
    if (platformDeepseekKey       !== undefined) { sets.push('deepseek_key=?');                 vals.push(platformDeepseekKey) }
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
    // Si cambiaron las credenciales de Google, invalida su caché para que el nuevo
    // client_id/secret se use de inmediato (sin esperar a que expire la caché).
    if (googleClientId !== undefined || googleClientSecret !== undefined || googleRedirectUri !== undefined || googleApiKey !== undefined) {
      try { require('../services/google').invalidateCredsCache() } catch {}
    }
    res.json({ ok: true })
  } catch (err) { console.error('[PUT SETTINGS]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Public endpoint — returns only safe/public platform fields (no auth required)
const getPublicIntegrations = async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT meta_app_id, meta_config_id, media_max_size_mb, brand_logo, brand_logo_light, brand_favicon, brand_name FROM platform_settings WHERE id=1')
    res.json({
      metaAppId: r?.meta_app_id || '',
      metaConfigId: r?.meta_config_id || '',
      mediaMaxSizeMb: r?.media_max_size_mb || 30,
      // Marca pública (para logo y favicon incluso antes de iniciar sesión). brandLogo = fondo
      // oscuro, brandLogoLight = fondo claro (el front elige según el tema activo).
      brandLogo: r?.brand_logo || '',
      brandLogoLight: r?.brand_logo_light || '',
      brandFavicon: r?.brand_favicon || '',
      brandName: r?.brand_name || '',
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
  const _pv = pw.validate(password); if (!_pv.ok) return res.status(400).json({ error: _pv.error })
  const id = 'sa_' + uid()
  try {
    await pool.query('INSERT INTO super_admins (id, name, email, password) VALUES (?, ?, ?, ?)', [id, name, email, await pw.toStored(password)])
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
    if (password) { const v = pw.validate(password); if (!v.ok) return res.status(400).json({ error: v.error }) }
    if (password)            { sets.push('password=?'); vals.push(await pw.toStored(password)) }
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
        tokensUsed: Number(u.tokens_used || 0) || ((u.basic_used || 0) + (u.medium_used || 0) + (u.complex_used || 0)),
        basicUsed: u.basic_used || 0,
        mediumUsed: u.medium_used || 0,
        complexUsed: u.complex_used || 0,
      }
    }
    res.json(accounts.map(a => ({
      id: a.id, name: a.name, email: a.email, plan: a.plan, status: a.status,
      nickname: a.nickname || a.name,
      modules: parseJ(a.modules, null),
      cmsStorageQuotaMb: a.cms_storage_quota_mb ?? null,
      changeAgentTokenQuota: a.change_agent_token_quota ?? null,
      // Si la cuenta tiene clave propia, y una pista para reconocerla. La clave ENTERA no
      // sale de aquí: es un secreto, y para saber si está puesta basta con el booleano.
      hasOpenaiKey: !!a.openai_key,
      hasDeepseekKey: !!a.deepseek_key,
      openaiKeyHint: a.openai_key ? '···' + String(a.openai_key).slice(-4) : '',
      deepseekKeyHint: a.deepseek_key ? '···' + String(a.deepseek_key).slice(-4) : '',
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
  // Crear cuenta desde el Super Panel = SOLO el nombre. Sin correo, sin owner y sin
  // generar prompt. El super admin entra a la cuenta y la configura después.
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' })
  const plan = req.body?.plan || 'free'
  const id = 'acc_' + uid()
  try {
    await pool.query(
      'INSERT INTO accounts (id,name,nickname,email,plan,status,channel_limits_override) VALUES (?,?,?,?,?,?,?)',
      [id, name, name, '', plan, 'active', '{"webchat":null,"test":null,"whatsapp":null,"messenger":null,"instagram":null}']
    )
    // Roles internos (necesarios para agregar miembros y para los permisos).
    await pool.query(
      'INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,1,?)',
      ['role_owner_' + uid(), id, 'Owner', '{"inbox":true,"agents":true,"channels":true,"crm":true,"pipeline":true,"config":true,"admins":true,"flows":true,"variables":true,"tools":true,"knowledge":true}']
    )
    await pool.query(
      'INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,0,?)',
      ['role_agent_' + uid(), id, 'Agente', '{"inbox":true,"agents":false,"channels":false,"crm":true,"pipeline":true,"config":false,"admins":false,"flows":false,"variables":false,"tools":false,"knowledge":false}']
    )
    // Aprovisiona el "agente IA de inicio" (variable respuesta_ia + flujos Generador y
    // transferir_a_asesor + herramienta + agente deepseek + canal webchat) con un prompt
    // genérico, para que la cuenta quede lista para chatear por webchat. Best-effort.
    try { await provisionStarterAgent(id, { agentName: name }) }
    catch (e) { console.warn('[provision starter]', e.message) }
    res.json({ id })
  } catch (err) {
    console.error('[POST ACCOUNT SA]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const updateSAAccount = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { accId } = req.params
  const { plan, status, channelLimitsOverride, changeAgentLimitOverride, changeAgentTokenLimitsOverride, changeAgentTokenQuota, changeAgentTokensUsed, modules, cmsStorageQuotaMb, nickname, name, openaiKey, deepseekKey } = req.body
  try {
    const sets = []; const vals = []
    if (plan                     !== undefined) { sets.push('plan=?');                      vals.push(plan) }
    if (status                   !== undefined) { sets.push('status=?');                    vals.push(status) }
    // Apodo interno (solo super admin lo cambia manualmente).
    if (nickname                 !== undefined) { sets.push('nickname=?');                  vals.push(nickname || null) }
    // Cambio de nombre desde el super panel: registra historial.
    if (name !== undefined) {
      const [[cur]] = await pool.query('SELECT name, nickname FROM accounts WHERE id=?', [accId])
      if (cur && cur.name !== name) {
        await pool.query('INSERT INTO account_name_history (id,account_id,old_name,new_name,changed_by,changed_at) VALUES (?,?,?,?,?,?)',
          ['anh_' + uid(), accId, cur.name || '', name || '', req.user?.name || 'Super Admin', Date.now()]).catch(() => {})
        if (!cur.nickname) { sets.push('nickname=?'); vals.push(cur.name || name) }
        sets.push('name=?'); vals.push(name)
      }
    }
    // Override de almacenamiento del CMS (plan "personalizado"): MB, o null = usar el plan.
    if (cmsStorageQuotaMb        !== undefined) { sets.push('cms_storage_quota_mb=?');      vals.push(cmsStorageQuotaMb === null || cmsStorageQuotaMb === '' ? null : Number(cmsStorageQuotaMb)) }
    // Claves de IA: se administran desde el super panel porque el coste de los modelos es de
    // la plataforma, no del cliente, que paga por plan. Vacío = usar la clave global.
    if (openaiKey                !== undefined) { sets.push('openai_key=?');               vals.push(String(openaiKey || '').trim() || null) }
    if (deepseekKey              !== undefined) { sets.push('deepseek_key=?');             vals.push(String(deepseekKey || '').trim() || null) }
    if (channelLimitsOverride    !== undefined) { sets.push('channel_limits_override=?');   vals.push(JSON.stringify(channelLimitsOverride)) }
    // Módulos override por cuenta: array de ids habilitados, o null = heredar del tipo / todos.
    if (modules                  !== undefined) { sets.push('modules=?');                   vals.push(Array.isArray(modules) ? JSON.stringify(modules) : null) }
    if (changeAgentLimitOverride !== undefined) { sets.push('change_agent_limit_override=?'); vals.push(changeAgentLimitOverride) }
    // Cupo único de tokens del Agente de Cambios por cuenta (null = usar el default global).
    if (changeAgentTokenQuota !== undefined) { sets.push('change_agent_token_quota=?'); vals.push(changeAgentTokenQuota === null || changeAgentTokenQuota === '' ? null : Number(changeAgentTokenQuota)) }
    if (changeAgentTokenLimitsOverride !== undefined) {
      sets.push('change_agent_token_limits_override=?')
      vals.push(changeAgentTokenLimitsOverride === null ? null : JSON.stringify(changeAgentTokenLimitsOverride))
    }
    if (sets.length) { vals.push(accId); await pool.query(`UPDATE accounts SET ${sets.join(',')} WHERE id=?`, vals) }

    // Consumo actual de tokens del Agente de Cambios (mes en curso): el super admin
    // puede fijarlo a un valor exacto o reiniciarlo (0 = restablece el cupo mensual).
    if (changeAgentTokensUsed !== undefined) {
      const month = new Date().toISOString().slice(0, 7)
      const used = Math.max(0, parseInt(changeAgentTokensUsed) || 0)
      await pool.query(
        `INSERT INTO change_agent_usage (account_id, month, used, tokens_used) VALUES (?,?,0,?)
         ON DUPLICATE KEY UPDATE tokens_used=?`,
        [accId, month, used, used]
      )
    }
    res.json({ ok: true })
  } catch (err) { console.error('[PUT SA ACCOUNT]', err); res.status(500).json({ error: 'Error interno' }) }
}

const deleteAccount = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    // Se lleva TODO lo que cuelga de la cuenta: el esquema no tiene claves foráneas en
    // cascada, así que un DELETE a secas dejaba huérfanas casi cien tablas.
    const r = await require('../services/accountPurge').purgeAccount(req.params.accId)
    if (r.errores.length) console.warn('[borrar cuenta]', r.errores.join(' · '))
    res.json({ ok: true, deletedRows: r.filas })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Historial de cambios de nombre de una cuenta (solo super admin).
const getAccountNameHistory = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    const [rows] = await pool.query('SELECT old_name, new_name, changed_by, changed_at FROM account_name_history WHERE account_id=? ORDER BY changed_at DESC', [req.params.accId])
    res.json(rows.map(r => ({ oldName: r.old_name, newName: r.new_name, changedBy: r.changed_by, changedAt: r.changed_at })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

async function _loadBrand() {
  try { const [[s]] = await pool.query('SELECT brand_logo, brand_name FROM platform_settings WHERE id=1'); return { name: s?.brand_name || '', logo: s?.brand_logo || '' } } catch { return {} }
}

// Plantillas de código que el super admin puede editar y previsualizar. Cualquier otro
// valor cae a 'login' (antes solo se reconocían 'login' y 'signup', así que una plantilla
// nueva se previsualizaba como la de acceso).
const EMAIL_PURPOSES = ['login', 'signup', 'reset']

// Envía un correo de prueba (solo super admin). Con { purpose, template } envía una
// prueba REAL de esa plantilla (con un código de ejemplo); si no, el correo genérico.
const testEmail = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const to = String(req.body?.to || '').trim()
  if (!to || !/.+@.+\..+/.test(to)) return res.status(400).json({ error: 'Correo destino inválido' })
  const { purpose, template } = req.body || {}
  try {
    let subject, html, text
    if (purpose && template) {
      const mail = renderCodeEmail(EMAIL_PURPOSES.includes(purpose) ? purpose : 'login', { code: '123456', templates: { [purpose]: template }, brand: await _loadBrand() })
      subject = mail.subject; html = mail.html; text = mail.text
    } else {
      subject = 'Correo de prueba — AVI Asistente'
      html = '<div style="font-family:Segoe UI,Arial,sans-serif;padding:20px;"><h2 style="color:#0b8a4f;">✓ Configuración de correo correcta</h2><p>Si recibes este mensaje, el proveedor de correo de AVI está configurado y funcionando.</p></div>'
      text = 'Configuración de correo correcta. El proveedor de correo de AVI funciona.'
    }
    const r = await sendEmail({ to, subject, html, text })
    if (!r.ok) return res.status(502).json({ error: r.error || 'No se pudo enviar' })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Renderiza una plantilla de correo (con código de ejemplo) para la vista previa
// del Super Panel. No envía nada. Solo super admin.
const emailPreview = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const { purpose, template } = req.body || {}
  try {
    const p = EMAIL_PURPOSES.includes(purpose) ? purpose : 'login'
    const mail = renderCodeEmail(p, { code: '123456', templates: { [p]: template || {} }, brand: await _loadBrand() })
    res.json({ subject: mail.subject, html: mail.html })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Analítica de módulos: por cada módulo, cuántas y cuáles cuentas lo usan (módulo efectivo:
// override de cuenta → preset del tipo → todos). Solo super admin.
const getModuleUsage = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    const modulesSvc = require('../services/modules')
    const [accts] = await pool.query("SELECT id, name, modules FROM accounts WHERE status<>'deleted'")
    const [subs]  = await pool.query('SELECT account_id, account_type_id FROM account_subscriptions')
    const [types] = await pool.query('SELECT id, name, modules FROM account_types')
    const typeById = Object.fromEntries(types.map(t => [t.id, t]))
    const typeOf   = Object.fromEntries(subs.map(s => [s.account_id, s.account_type_id]))
    const usage = Object.fromEntries(modulesSvc.MODULE_IDS.map(id => [id, []]))
    for (const a of accts) {
      const typeModules = typeById[typeOf[a.id]]?.modules ?? null
      const eff = modulesSvc.resolveModules(a.modules, typeModules)
      for (const id of modulesSvc.MODULE_IDS) if (eff[id]) usage[id].push({ id: a.id, name: a.name })
    }
    const modules = modulesSvc.MODULES.map(m => ({
      id: m.id, name: m.name, description: m.description,
      count: usage[m.id].length, accounts: usage[m.id].sort((x, y) => String(x.name).localeCompare(String(y.name))),
    })).sort((a, b) => b.count - a.count)
    res.json({ totalAccounts: accts.length, modules })
  } catch (err) { console.error('[module usage]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Exenciones del 2FA de login ───────────────────────────────────────────────
//
// Quitarle a alguien el segundo factor es DEBILITAR su cuenta a propósito, y a veces hace
// falta: una cuenta compartida por un equipo, una integración que entra con usuario y
// contraseña, o alguien que perdió el acceso a su correo. Por eso se concede de una en una,
// solo el super admin, y queda registrado quién la dio y cuándo.

const normEmail = e => String(e || '').trim().toLowerCase()

const list2faExempt = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    const [rows] = await pool.query('SELECT email, reason, granted_by, created_at FROM login_2fa_exempt ORDER BY created_at DESC')
    res.json(rows.map(r => ({ email: r.email, reason: r.reason || '', grantedBy: r.granted_by || '', createdAt: Number(r.created_at) || 0 })))
  } catch (err) { console.error('[2fa exentos]', err); res.status(500).json({ error: 'Error interno' }) }
}

const add2faExempt = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  const email = normEmail(req.body?.email)
  const reason = String(req.body?.reason || '').trim().slice(0, 300)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Correo no válido' })
  try {
    // Se avisa si ese correo no corresponde a nadie: casi siempre es una errata, y una
    // exencion sobre un correo inexistente no protege ni sirve — solo estorba en la lista.
    const [[m]] = await pool.query('SELECT email FROM members WHERE email=? LIMIT 1', [email])
    const [[sa]] = await pool.query('SELECT email FROM super_admins WHERE email=? LIMIT 1', [email])
    const existe = !!(m || sa)

    await pool.query(
      'INSERT INTO login_2fa_exempt (email, reason, granted_by, created_at) VALUES (?,?,?,?) ' +
      'ON DUPLICATE KEY UPDATE reason=VALUES(reason), granted_by=VALUES(granted_by), created_at=VALUES(created_at)',
      [email, reason, req.user.email || req.user.id || '', Date.now()])
    console.log(`[2FA] exención concedida a ${email} por ${req.user.email || req.user.id}${reason ? ' — ' + reason : ''}`)
    res.json({ ok: true, existe })
  } catch (err) { console.error('[2fa exentos]', err); res.status(500).json({ error: 'Error interno' }) }
}

const remove2faExempt = async (req, res) => {
  if (req.user.type !== 'superadmin') return res.status(403).json({ error: 'Solo super admin' })
  try {
    const email = normEmail(req.params.email)
    await pool.query('DELETE FROM login_2fa_exempt WHERE email=?', [email])
    console.log(`[2FA] exención retirada a ${email} por ${req.user.email || req.user.id}`)
    res.json({ ok: true })
  } catch (err) { console.error('[2fa exentos]', err); res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { list2faExempt, add2faExempt, remove2faExempt, getSettings, updateSettings, getPublicIntegrations, listSuperAdmins, createSuperAdmin, updateSuperAdmin, deleteSuperAdmin, listAllUsers, listAccounts, createAccount, updateSAAccount, deleteAccount, getAccountNameHistory, testEmail, emailPreview, getModuleUsage }
