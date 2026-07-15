'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const express    = require('express')
const http       = require('http')
const { Server } = require('socket.io')
const cors       = require('cors')
const { verify } = require('./auth')
const socket     = require('./services/socket')

const app    = express()
const server = http.createServer(app)
const io     = new Server(server, { cors: { origin: '*' } })

// Init socket service with io instance
socket.init(io)

app.use(cors({ origin: '*' }))
// Guarda el body crudo (req.rawBody) para verificar firmas de webhooks (WooCommerce).
app.use(express.json({ limit: '25mb', verify: (req, _res, buf) => { req.rawBody = buf } }))  // headroom para la base de conocimiento (RAG) y otros JSON grandes

// ── Socket.io: auth + room management ────────────────────────────────────────

io.use((sock, next) => {
  const token = sock.handshake.auth?.token
  sock.user = token ? verify(token) : null
  next()
})

// Presencia de asesores por conversación: convId -> Map(socketId -> {userId,userName})
const convPresence = new Map()
function emitPresence(convId) {
  const m = convPresence.get(convId)
  const users = m ? [...m.values()] : []
  io.to(`conv:${convId}`).emit('presence:list', { convId, users })
}
function removePresence(sock, convId) {
  if (!convId) return
  const m = convPresence.get(convId)
  if (m) { m.delete(sock.id); if (m.size === 0) convPresence.delete(convId) }
  emitPresence(convId)
}

io.on('connection', sock => {
  const u = sock.user
  if (u) {
    const ids = u.allAccountIds || (u.accountId ? [u.accountId] : [])
    ids.forEach(aId => sock.join(`acc:${aId}`))
    // Personal room for direct messages between team members
    if (u.id) sock.join(`mem:${u.id}`)
  }
  // Allow guests to join a per-conversation room for real-time webchat
  sock.on('join:conv',  convId => sock.join(`conv:${convId}`))
  sock.on('leave:conv', convId => sock.leave(`conv:${convId}`))

  // ── Presencia de asesores en un chat (quién lo está viendo ahora) ──────────
  sock.on('presence:join', ({ convId, userId, userName }) => {
    if (!convId || !userId) return
    // Un socket solo está presente en un chat a la vez: limpia el anterior
    if (sock.data.presenceConv && sock.data.presenceConv !== convId) {
      removePresence(sock, sock.data.presenceConv)
    }
    sock.join(`conv:${convId}`)
    sock.data.presenceConv = convId
    if (!convPresence.has(convId)) convPresence.set(convId, new Map())
    convPresence.get(convId).set(sock.id, { userId, userName: userName || 'Asesor' })
    emitPresence(convId)
  })
  sock.on('presence:leave', ({ convId }) => {
    removePresence(sock, convId || sock.data.presenceConv)
    if (sock.data.presenceConv === convId) sock.data.presenceConv = null
  })
  sock.on('disconnect', () => {
    if (sock.data.presenceConv) removePresence(sock, sock.data.presenceConv)
  })
})

// ── Public routes (no auth) ───────────────────────────────────────────────────
const { getPublicAccount } = require('./controllers/accounts.controller')
app.get('/api/public/accounts/:accId', getPublicAccount)

// ── Routes ────────────────────────────────────────────────────────────────────

const authRoutes          = require('./routes/auth.routes')
const accountRoutes       = require('./routes/accounts.routes')
const agentRoutes         = require('./routes/agents.routes')
const memberRoutes        = require('./routes/members.routes')
const pipelineRoutes      = require('./routes/pipelines.routes')
const resourceRoutes      = require('./routes/resources.routes')
const conversationRoutes  = require('./routes/conversations.routes')
const teamchatRoutes      = require('./routes/teamchat.routes')
const supportRoutes       = require('./routes/support.routes')
const ragRoutes           = require('./routes/rag.routes')
const backupRoutes        = require('./routes/backups.routes')
const inviteRoutes        = require('./routes/invites.routes')
const platformRoutes      = require('./routes/platform.routes')
const webhookRoutes       = require('./routes/webhooks.routes')
const metaCatalogRoutes   = require('./routes/metaCatalog.routes')
const metaPagesRoutes     = require('./routes/metaPages.routes')
const optimizerRoutes     = require('./routes/promptOptimizer.routes')
const recontactRoutes     = require('./routes/recontact.routes')
const promptGenRoutes     = require('./routes/promptGenerator.routes')
const promptHistoryRoutes = require('./routes/promptHistory.routes')
const mediaRoutes         = require('./routes/media.routes')
const quickRepliesRoutes  = require('./routes/quickReplies.routes')
const crmRoutes           = require('./routes/crm.routes')
const contactsRoutes      = require('./routes/contacts.routes')
const savedFiltersRoutes  = require('./routes/savedFilters.routes')
const campaignsRoutes     = require('./routes/campaigns.routes')
const subscriptionsRoutes = require('./routes/subscriptions.routes')
const demoRoutes          = require('./routes/demo.routes')
const apiKeysRoutes       = require('./routes/apiKeys.routes')
const publicApiRoutes     = require('./routes/publicApi.routes')
const analyticsRoutes     = require('./routes/analytics.routes')
const tutorialsRoutes     = require('./routes/tutorials.routes')
const waTemplatesRoutes   = require('./routes/whatsappTemplates.routes')
const googleRoutes        = require('./routes/google.routes')
const flowLogsRoutes      = require('./routes/flowLogs.routes')
const aiMediaRoutes       = require('./routes/aiMedia.routes')
const calendarRoutes      = require('./routes/calendars.routes')
const woocommerceRoutes   = require('./routes/woocommerce.routes')
const paymentsRoutes      = require('./routes/payments.routes')
const pushRoutes          = require('./routes/push.routes')
const schedulingRoutes    = require('./routes/scheduling.routes')
const pmsRoutes           = require('./routes/pms.routes')
const ordersRoutes        = require('./routes/orders.routes')

// Guest counter alias (used by storage.js generateGuest)
const guestRouter = require('express').Router()
guestRouter.post('/next', require('./controllers/conversations.controller').getGuest)
app.use('/api/guest', guestRouter)

app.use('/api/auth',          authRoutes)
app.use('/api/accounts',      accountRoutes)
app.use('/api',               agentRoutes)
app.use('/api',               memberRoutes)
app.use('/api',               pipelineRoutes)
app.use('/api',               resourceRoutes)
app.use('/api',               savedFiltersRoutes)
app.use('/api',               campaignsRoutes)
app.use('/api/conversations',  conversationRoutes)
app.use('/api/teamchat',       teamchatRoutes)
app.use('/api/support',        supportRoutes)
app.use('/api/rag',            ragRoutes)
app.use('/api/backups',        backupRoutes)
app.use('/api/invites',        inviteRoutes)
app.use('/api',                platformRoutes)
app.use('/api',                promptGenRoutes)
app.use('/api',                promptHistoryRoutes)
app.use('/api',                mediaRoutes)
app.use('/api',                quickRepliesRoutes)
app.use('/api',                crmRoutes)
app.use('/api',                contactsRoutes)
app.use('/api',                subscriptionsRoutes)
app.use('/api',                demoRoutes)
app.use('/api',                apiKeysRoutes)
app.use('/api',                publicApiRoutes)
app.use('/api',                analyticsRoutes)
app.use('/api',                tutorialsRoutes)
app.use('/api',                waTemplatesRoutes)
app.use('/api',                googleRoutes)
app.use('/api',                flowLogsRoutes)
app.use('/api',                aiMediaRoutes)
app.use('/api',                calendarRoutes)
app.use('/api',                woocommerceRoutes)
app.use('/api',                paymentsRoutes)
app.use('/api',                pushRoutes)
app.use('/api',                schedulingRoutes)
app.use('/api',                pmsRoutes)
app.use('/api',                ordersRoutes)
app.use('/api',                require('./routes/portal.routes'))
app.use('/api',                webhookRoutes)
app.use('/api',                metaCatalogRoutes)
app.use('/api',                metaPagesRoutes)
app.use('/api',                optimizerRoutes)
app.use('/api',                recontactRoutes)

// ── Auto-migrate DB columns added after initial schema ────────────────────────
;(async () => {
  const pool = require('./db')
  // ADD COLUMN IF NOT EXISTS only works in MySQL 8.0.29+ — use ADD COLUMN and swallow "duplicate column" errors
  const migrations = [
    // Perfil de usuario: foto propia (data URL o enlace) por miembro y super admin.
    "ALTER TABLE members ADD COLUMN photo MEDIUMTEXT",
    "ALTER TABLE super_admins ADD COLUMN photo MEDIUMTEXT",
    // Tema de chat predeterminado de la cuenta (aplica a todos sus usuarios).
    "ALTER TABLE accounts ADD COLUMN chat_theme JSON",
    // Optimizador más descriptivo: por qué del cambio + ejemplos reales.
    "ALTER TABLE optimizer_suggestions ADD COLUMN why TEXT",
    "ALTER TABLE optimizer_suggestions ADD COLUMN examples JSON",
    // Almacenamiento del CMS por plan: cuota (MB) en el tipo de cuenta + override
    // por cuenta (plan "personalizado" que define el super admin). NULL = usa el plan.
    "ALTER TABLE account_types ADD COLUMN cms_storage_mb INT DEFAULT 500",
    "ALTER TABLE accounts ADD COLUMN cms_storage_quota_mb INT",
    // Estado de conversaciones: archivada / bloqueada.
    "ALTER TABLE conversations ADD COLUMN archived TINYINT(1) DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN blocked TINYINT(1) DEFAULT 0",
    // Chats en seguimiento: marcados con estrella + avatar con animación de respiración.
    "ALTER TABLE conversations ADD COLUMN followup TINYINT(1) DEFAULT 0",
    // Contacto recurrente: el cliente ya había conversado antes (por contacto
    // existente, memoria previa, o historial sincronizado por Coexistencia de WhatsApp).
    "ALTER TABLE conversations ADD COLUMN returning_contact TINYINT(1) DEFAULT 0",
    // Clasificación IA (CRM): tema/motivo y sentimiento de la conversación.
    "ALTER TABLE conversations ADD COLUMN topic VARCHAR(40)",
    "ALTER TABLE conversations ADD COLUMN sentiment VARCHAR(12)",
    "ALTER TABLE conversations ADD COLUMN classified_at BIGINT",
    "ALTER TABLE conversations ADD INDEX idx_conv_topic (account_id, topic)",
    // Métricas de atención: tiempo de 1ª respuesta (ms) y desenlace (atendido/derivado/sin_respuesta).
    "ALTER TABLE conversations ADD COLUMN first_response_ms BIGINT",
    "ALTER TABLE conversations ADD COLUMN outcome VARCHAR(16)",
    // Intención de compra detectada por la IA (nula/baja/media/alta) → pipeline conversacional.
    "ALTER TABLE conversations ADD COLUMN buying_intent VARCHAR(10)",
    // QA del asistente: puntaje de calidad (0-100) + problema detectado por la IA revisora.
    "ALTER TABLE conversations ADD COLUMN qa_score INT",
    "ALTER TABLE conversations ADD COLUMN qa_flag VARCHAR(160)",
    "ALTER TABLE conversations ADD COLUMN qa_at BIGINT",
    // Historial de movimientos de deals entre etapas (para velocidad/conversión del embudo).
    `CREATE TABLE IF NOT EXISTS deal_stage_history (
       id BIGINT PRIMARY KEY AUTO_INCREMENT, account_id VARCHAR(50) NOT NULL,
       pipeline_id VARCHAR(50), card_id VARCHAR(50), from_stage VARCHAR(50), to_stage VARCHAR(50), at BIGINT,
       INDEX idx_dsh (account_id, card_id), INDEX idx_dsh_pipe (account_id, pipeline_id)
     )`,
    // Segmentos dinámicos de contactos (listas vivas reutilizables en campañas y reportes).
    `CREATE TABLE IF NOT EXISTS contact_segments (
       id VARCHAR(50) PRIMARY KEY, account_id VARCHAR(50) NOT NULL,
       name VARCHAR(120), rules JSON, created_at BIGINT,
       INDEX idx_seg (account_id)
     )`,
    // Reglas/playbooks no-code: "si pasa X, haz Y" (evaluadas por un worker).
    `CREATE TABLE IF NOT EXISTS crm_rules (
       id VARCHAR(50) PRIMARY KEY, account_id VARCHAR(50) NOT NULL,
       name VARCHAR(140), trigger_type VARCHAR(30), trigger_days INT DEFAULT 7,
       action_type VARCHAR(30) DEFAULT 'create_task', action_params JSON,
       enabled TINYINT(1) DEFAULT 1, last_run BIGINT, created_at BIGINT,
       INDEX idx_rules (account_id)
     )`,
    // Registro de disparos (evita que una regla actúe dos veces sobre el mismo objetivo).
    `CREATE TABLE IF NOT EXISTS crm_rule_fires (
       rule_id VARCHAR(50), target_id VARCHAR(80), fired_at BIGINT,
       PRIMARY KEY (rule_id, target_id)
     )`,
    // Publicidad en cuentas Demo: código de anuncio (embed) gestionado por el super admin.
    "ALTER TABLE platform_settings ADD COLUMN demo_ads_enabled TINYINT(1) DEFAULT 0",
    "ALTER TABLE platform_settings ADD COLUMN demo_ads_html MEDIUMTEXT",
    // Agente de Cambios: UN solo cupo de tokens totales (sin tipos). Default de
    // plataforma + override por cuenta + consumo total mensual.
    "ALTER TABLE platform_settings ADD COLUMN change_agent_token_limit INT DEFAULT 95000",
    "ALTER TABLE accounts ADD COLUMN change_agent_token_quota INT",
    "ALTER TABLE change_agent_usage ADD COLUMN tokens_used BIGINT DEFAULT 0",
    "UPDATE change_agent_usage SET tokens_used = COALESCE(basic_used,0)+COALESCE(medium_used,0)+COALESCE(complex_used,0) WHERE (tokens_used IS NULL OR tokens_used=0) AND (COALESCE(basic_used,0)+COALESCE(medium_used,0)+COALESCE(complex_used,0)) > 0",
    // Agente de Cambios: capacidades globales activables por el super admin
    // (qué puede modificar: prompt / herramientas / flujos / agendas).
    "ALTER TABLE platform_settings ADD COLUMN change_agent_caps TEXT",
    // Herramienta IA Especial PMS (HosRoom/Kunas): config por cuenta (proveedor + token).
    "ALTER TABLE accounts ADD COLUMN pms TEXT",
    // ── Módulo Pedidos y Domicilios ──────────────────────────────────────────
    // Config por cuenta (tipos de pedido, moneda, tarifas, mínimos, pago…).
    "ALTER TABLE accounts ADD COLUMN orders TEXT",
    `CREATE TABLE IF NOT EXISTS order_products (
       id VARCHAR(50) PRIMARY KEY, account_id VARCHAR(50) NOT NULL,
       category VARCHAR(120) DEFAULT '', name VARCHAR(200) NOT NULL, description TEXT,
       price DECIMAL(12,2) DEFAULT 0, media_id VARCHAR(50), image_url TEXT,
       modifier_group_ids TEXT, available TINYINT(1) DEFAULT 1, sort INT DEFAULT 0,
       source VARCHAR(20) DEFAULT 'menu', source_ref VARCHAR(120), created_at BIGINT,
       INDEX idx_op_acc (account_id, category)
     )`,
    `CREATE TABLE IF NOT EXISTS order_modifier_groups (
       id VARCHAR(50) PRIMARY KEY, account_id VARCHAR(50) NOT NULL,
       name VARCHAR(160) NOT NULL, min_select INT DEFAULT 0, max_select INT DEFAULT 1,
       required TINYINT(1) DEFAULT 0, sort INT DEFAULT 0, created_at BIGINT,
       INDEX idx_omg_acc (account_id)
     )`,
    `CREATE TABLE IF NOT EXISTS order_modifiers (
       id VARCHAR(50) PRIMARY KEY, group_id VARCHAR(50) NOT NULL, account_id VARCHAR(50) NOT NULL,
       name VARCHAR(160) NOT NULL, price_delta DECIMAL(12,2) DEFAULT 0, available TINYINT(1) DEFAULT 1,
       sort INT DEFAULT 0,
       INDEX idx_om_group (group_id)
     )`,
    `CREATE TABLE IF NOT EXISTS order_zones (
       id VARCHAR(50) PRIMARY KEY, account_id VARCHAR(50) NOT NULL,
       name VARCHAR(160) NOT NULL, fee DECIMAL(12,2) DEFAULT 0, min_order DECIMAL(12,2) DEFAULT 0,
       eta_min INT DEFAULT 0, sort INT DEFAULT 0, created_at BIGINT,
       INDEX idx_oz_acc (account_id)
     )`,
    // Zonas de entrega dibujadas en un mapa: además del cobro/tiempo, guardan la
    // ciudad, un polígono (GeoJSON simplificado [[lat,lng],…]), color, estado
    // activo/inactivo e info adicional. El asistente geocodifica la dirección y
    // usa point-in-polygon para saber si cae dentro de la cobertura.
    "ALTER TABLE order_zones ADD COLUMN city VARCHAR(120)",
    "ALTER TABLE order_zones ADD COLUMN active TINYINT(1) DEFAULT 1",
    "ALTER TABLE order_zones ADD COLUMN color VARCHAR(20)",
    "ALTER TABLE order_zones ADD COLUMN polygon JSON",
    "ALTER TABLE order_zones ADD COLUMN extra_info TEXT",
    `CREATE TABLE IF NOT EXISTS order_couriers (
       id VARCHAR(50) PRIMARY KEY, account_id VARCHAR(50) NOT NULL,
       name VARCHAR(160) NOT NULL, phone VARCHAR(40), active TINYINT(1) DEFAULT 1, created_at BIGINT,
       INDEX idx_oc_acc (account_id)
     )`,
    `CREATE TABLE IF NOT EXISTS orders (
       id VARCHAR(50) PRIMARY KEY, account_id VARCHAR(50) NOT NULL, agent_id VARCHAR(50),
       conv_id VARCHAR(50), contact_id VARCHAR(50), code VARCHAR(30),
       type VARCHAR(20) DEFAULT 'delivery', status VARCHAR(24) DEFAULT 'draft',
       items MEDIUMTEXT, subtotal DECIMAL(12,2) DEFAULT 0, delivery_fee DECIMAL(12,2) DEFAULT 0,
       tax DECIMAL(12,2) DEFAULT 0, tip DECIMAL(12,2) DEFAULT 0, packaging_fee DECIMAL(12,2) DEFAULT 0,
       discount DECIMAL(12,2) DEFAULT 0, total DECIMAL(12,2) DEFAULT 0, currency VARCHAR(6) DEFAULT 'COP',
       address MEDIUMTEXT, zone_id VARCHAR(50), table_label VARCHAR(60), scheduled_for VARCHAR(40),
       courier_id VARCHAR(50), payment_method VARCHAR(20), payment_status VARCHAR(20) DEFAULT 'pending',
       cash_amount DECIMAL(12,2), notes TEXT, timeline MEDIUMTEXT,
       created_at BIGINT, updated_at BIGINT,
       INDEX idx_ord_acc (account_id, status), INDEX idx_ord_conv (conv_id)
     )`,
    // Datos del cliente en el propio pedido (para el tablero operativo sin join).
    "ALTER TABLE orders ADD COLUMN customer_name VARCHAR(160)",
    "ALTER TABLE orders ADD COLUMN customer_phone VARCHAR(40)",
    // Referencia del intento de pago (para confirmar el pedido desde el webhook).
    "ALTER TABLE orders ADD COLUMN payment_ref VARCHAR(80)",
    "ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(40)",
    // Precio de oferta (promo) opcional por producto.
    "ALTER TABLE order_products ADD COLUMN promo_price DECIMAL(12,2)",
    // Combo: lista de productos incluidos [{productId,name,qty}] (si tiene, el producto es un combo).
    "ALTER TABLE order_products ADD COLUMN combo_items MEDIUMTEXT",
    // Cupones de descuento del módulo de pedidos.
    `CREATE TABLE IF NOT EXISTS order_coupons (
       id VARCHAR(50) PRIMARY KEY, account_id VARCHAR(50) NOT NULL,
       code VARCHAR(40) NOT NULL, type VARCHAR(10) DEFAULT 'percent',
       value DECIMAL(12,2) DEFAULT 0, min_order DECIMAL(12,2) DEFAULT 0,
       max_discount DECIMAL(12,2) DEFAULT 0, uses_max INT DEFAULT 0, uses_count INT DEFAULT 0,
       active TINYINT(1) DEFAULT 1, expires_at BIGINT, created_at BIGINT,
       INDEX idx_oc_acc (account_id), INDEX idx_oc_code (account_id, code)
     )`,
    // Conciencia temporal de la IA: zona horaria local + (opcional) fecha/hora base fija.
    "ALTER TABLE accounts ADD COLUMN ai_timezone VARCHAR(64) DEFAULT 'America/Lima'",
    "ALTER TABLE accounts ADD COLUMN ai_datetime_enabled TINYINT(1) DEFAULT 1",
    "ALTER TABLE accounts ADD COLUMN ai_base_datetime VARCHAR(40)",
    // Correo transaccional (Resend/SendGrid vía API HTTP) + verificación de registro
    // y 2FA en login. Todo opt-in: sin proveedor configurado, nada cambia.
    "ALTER TABLE platform_settings ADD COLUMN email_provider VARCHAR(20) DEFAULT 'none'",
    "ALTER TABLE platform_settings ADD COLUMN email_api_key TEXT",
    "ALTER TABLE platform_settings ADD COLUMN email_from VARCHAR(200)",
    "ALTER TABLE platform_settings ADD COLUMN email_from_name VARCHAR(160)",
    "ALTER TABLE platform_settings ADD COLUMN signup_verify_enabled TINYINT(1) DEFAULT 0",
    "ALTER TABLE platform_settings ADD COLUMN login_2fa_enabled TINYINT(1) DEFAULT 0",
    // Modelo IA que ejecuta las acciones IA del CRM/negocio (clasificación, resúmenes, copiloto…).
    "ALTER TABLE platform_settings ADD COLUMN business_ai_model VARCHAR(60) DEFAULT 'gpt-4o-mini'",
    `CREATE TABLE IF NOT EXISTS email_codes (
       id         VARCHAR(50) PRIMARY KEY,
       email      VARCHAR(200) NOT NULL,
       code       VARCHAR(10)  NOT NULL,
       purpose    VARCHAR(20)  NOT NULL,
       expires_at BIGINT       NOT NULL,
       consumed   TINYINT(1)   DEFAULT 0,
       attempts   INT          DEFAULT 0,
       created_at BIGINT,
       INDEX idx_ec_email (email, purpose)
     )`,
    // Apodo interno de la cuenta (identificador estable, no cambia con el nombre)
    // + historial de cambios de nombre.
    "ALTER TABLE accounts ADD COLUMN nickname VARCHAR(120)",
    "UPDATE accounts SET nickname=name WHERE nickname IS NULL OR nickname=''",
    `CREATE TABLE IF NOT EXISTS account_name_history (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       old_name    VARCHAR(200),
       new_name    VARCHAR(200),
       changed_by  VARCHAR(120),
       changed_at  BIGINT,
       INDEX idx_anh_acc (account_id, changed_at)
     )`,
    // Optimizador Inteligente del Prompt (análisis incremental de conversaciones).
    "ALTER TABLE platform_settings ADD COLUMN optimizer_model VARCHAR(60) DEFAULT 'gpt-4o-mini'",
    `CREATE TABLE IF NOT EXISTS optimizer_convo_index (
       conversation_id VARCHAR(80) PRIMARY KEY,
       account_id      VARCHAR(50) NOT NULL,
       agent_id        VARCHAR(50) NOT NULL,
       prompt_version  VARCHAR(40),
       msg_count       INT DEFAULT 0,
       last_msg_ts     BIGINT DEFAULT 0,
       seen_updated_at BIGINT DEFAULT 0,
       duration_ms     BIGINT DEFAULT 0,
       topic           VARCHAR(60),
       resolved        TINYINT(1) DEFAULT 0,
       confidence      DECIMAL(3,2) DEFAULT 0,
       used_rag        TINYINT(1) DEFAULT 0,
       rag_hit         TINYINT(1) DEFAULT 0,
       tools_used      JSON,
       errors          JSON,
       reformulations  INT DEFAULT 0,
       asked_human     TINYINT(1) DEFAULT 0,
       abandoned       TINYINT(1) DEFAULT 0,
       fail_reason     VARCHAR(40),
       embedding       JSON,
       analyzed_at     BIGINT,
       INDEX idx_oci_agent (account_id, agent_id),
       INDEX idx_oci_candidate (account_id, agent_id, fail_reason)
     )`,
    `CREATE TABLE IF NOT EXISTS optimizer_suggestions (
       id            VARCHAR(40) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL,
       agent_id      VARCHAR(50) NOT NULL,
       title         VARCHAR(200),
       description   TEXT,
       problem_type  VARCHAR(30),
       severity      VARCHAR(20),
       impact        VARCHAR(20),
       frequency     INT DEFAULT 0,
       conversations JSON,
       evidence      JSON,
       proposed_change JSON,
       status        VARCHAR(20) DEFAULT 'new',
       dedupe_key    VARCHAR(120),
       applied_version VARCHAR(50),
       created_at    BIGINT,
       updated_at    BIGINT,
       INDEX idx_osg_agent (account_id, agent_id, status),
       INDEX idx_osg_dedupe (account_id, agent_id, dedupe_key)
     )`,
    `CREATE TABLE IF NOT EXISTS optimizer_runs (
       id            VARCHAR(40) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL,
       agent_id      VARCHAR(50) NOT NULL,
       started_by    VARCHAR(100),
       prompt_version VARCHAR(40),
       convos_processed INT DEFAULT 0,
       last_cursor_ts BIGINT DEFAULT 0,
       suggestions_new INT DEFAULT 0,
       suggestions_updated INT DEFAULT 0,
       suggestions_resolved INT DEFAULT 0,
       status        VARCHAR(20) DEFAULT 'running',
       tokens_used   INT DEFAULT 0,
       cost_usd      DECIMAL(12,6) DEFAULT 0,
       started_at    BIGINT,
       finished_at   BIGINT,
       INDEX idx_orun_agent (account_id, agent_id, started_at)
     )`,
    "ALTER TABLE optimizer_suggestions ADD COLUMN code VARCHAR(20)",
    // Webhook de Google Calendar en tiempo real (canales push events.watch).
    `CREATE TABLE IF NOT EXISTS google_calendar_channels (
       channel_id           VARCHAR(80) PRIMARY KEY,
       account_id           VARCHAR(50) NOT NULL,
       platform_calendar_id VARCHAR(50) NOT NULL,
       google_calendar_id   VARCHAR(255),
       resource_id          VARCHAR(255),
       channel_token        VARCHAR(80),
       sync_token           TEXT,
       expiration           BIGINT,
       created_at           BIGINT,
       INDEX idx_gcc_acc (account_id, platform_calendar_id)
     )`,
    // Recontactos inteligentes (re-enganche de conversaciones abandonadas).
    "ALTER TABLE accounts          ADD COLUMN recontact JSON",
    "ALTER TABLE conversations     ADD COLUMN recontact_at BIGINT",
    "ALTER TABLE conversations     ADD COLUMN recontact_count INT DEFAULT 0",
    // Sistema de módulos por cuenta (gating de funcionalidades).
    "ALTER TABLE accounts          ADD COLUMN modules JSON",
    "ALTER TABLE account_types     ADD COLUMN modules JSON",
    // Catálogo de Meta (Commerce) conectado a la cuenta.
    "ALTER TABLE accounts          ADD COLUMN meta_catalog JSON",
    "ALTER TABLE platform_settings ADD COLUMN meta_app_id VARCHAR(64) DEFAULT ''",
    "ALTER TABLE platform_settings ADD COLUMN change_agent_token_limits JSON",
    "ALTER TABLE platform_settings ADD COLUMN prompt_generator_model VARCHAR(50) DEFAULT 'gpt-4o'",
    "ALTER TABLE platform_settings ADD COLUMN prompt_generator_structure TEXT",
    "ALTER TABLE platform_settings ADD COLUMN prompt_generator_allow_flows TINYINT(1) DEFAULT 1",
    "ALTER TABLE accounts          ADD COLUMN change_agent_token_limits_override JSON",
    "ALTER TABLE change_agent_usage ADD COLUMN basic_used INT DEFAULT 0",
    "ALTER TABLE change_agent_usage ADD COLUMN medium_used INT DEFAULT 0",
    "ALTER TABLE change_agent_usage ADD COLUMN complex_used INT DEFAULT 0",
    "ALTER TABLE accounts          ADD COLUMN anthropic_key TEXT",
    "ALTER TABLE platform_settings ADD COLUMN media_max_size_mb INT DEFAULT 30",
    "ALTER TABLE platform_settings ADD COLUMN prompt_generator_max_file_mb INT DEFAULT 30",
    `CREATE TABLE IF NOT EXISTS api_keys (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       name        VARCHAR(100),
       key_hash    VARCHAR(100),
       prefix      VARCHAR(20),
       scopes      JSON,
       last_used   BIGINT,
       created_at  BIGINT,
       INDEX idx_api_keys_acc  (account_id),
       INDEX idx_api_keys_hash (key_hash)
     )`,
    "ALTER TABLE crm_tasks ADD COLUMN refs JSON",
    "ALTER TABLE support_tickets ADD COLUMN refs JSON",
    // Calificación del asesor (1-10) + nota, que deja quien creó el ticket al cerrarse.
    "ALTER TABLE support_tickets ADD COLUMN rating INT",
    "ALTER TABLE support_tickets ADD COLUMN rating_note TEXT",
    "ALTER TABLE support_tickets ADD COLUMN rated_at BIGINT",
    // Round-robin + "tomado": assigned_to = pre-asignado; taken_by = quien lo tomó de verdad.
    "ALTER TABLE support_tickets ADD COLUMN taken_by JSON",
    "ALTER TABLE support_tickets ADD COLUMN taken_at BIGINT",
    // Prioridad manual (daño al cliente) que fija el super admin: baja/media/alta/urgente.
    "ALTER TABLE support_tickets ADD COLUMN priority VARCHAR(10)",
    // Notas internas del super admin sobre el ticket (no visibles para el cliente).
    "ALTER TABLE support_tickets ADD COLUMN notes JSON",
    // Fecha aproximada de entrega de la solución (ETA) + momento real de cierre (entrega).
    "ALTER TABLE support_tickets ADD COLUMN eta BIGINT",
    "ALTER TABLE support_tickets ADD COLUMN closed_at BIGINT",
    // Historial de tomas/asignaciones (para supervisar quién ha tomado cada ticket).
    "ALTER TABLE support_tickets ADD COLUMN assign_history JSON",
    // Reporte del ticket por el cliente (con nota). Los reportados salen en su sección.
    // `reported` queda en 1 para siempre (marca histórica); `report_resolved` indica si
    // el soporte ya lo atendió — el ticket NO sale de la lista de reportados al resolverse.
    "ALTER TABLE support_tickets ADD COLUMN reported TINYINT(1) DEFAULT 0",
    "ALTER TABLE support_tickets ADD COLUMN report_note TEXT",
    "ALTER TABLE support_tickets ADD COLUMN reported_at BIGINT",
    "ALTER TABLE support_tickets ADD COLUMN reported_by JSON",
    "ALTER TABLE support_tickets ADD COLUMN report_resolved TINYINT(1) DEFAULT 0",
    "ALTER TABLE support_tickets ADD COLUMN report_resolved_at BIGINT",
    "ALTER TABLE support_tickets ADD COLUMN report_resolved_by JSON",
    `CREATE TABLE IF NOT EXISTS flow_executions (
       id BIGINT PRIMARY KEY AUTO_INCREMENT,
       account_id VARCHAR(50) NOT NULL,
       agent_id   VARCHAR(50),
       conv_id    VARCHAR(80),
       flow_id    VARCHAR(50),
       flow_name  VARCHAR(150),
       trigger_type VARCHAR(40),
       status     VARCHAR(20),
       error      TEXT,
       duration_ms INT,
       started_at BIGINT,
       source     VARCHAR(20) DEFAULT 'chat',
       INDEX idx_fe_acc (account_id, started_at),
       INDEX idx_fe_status (account_id, status, started_at),
       INDEX idx_fe_conv (account_id, conv_id)
     )`,
    `CREATE TABLE IF NOT EXISTS error_log (
       id BIGINT PRIMARY KEY AUTO_INCREMENT,
       account_id VARCHAR(50) NOT NULL,
       agent_id   VARCHAR(50),
       conv_id    VARCHAR(80),
       source     VARCHAR(60),
       message    TEXT,
       detail     TEXT,
       ts         BIGINT,
       INDEX idx_el_acc (account_id, ts)
     )`,
    `CREATE TABLE IF NOT EXISTS google_integrations (
       account_id    VARCHAR(50) PRIMARY KEY,
       email         VARCHAR(200),
       access_token  TEXT,
       refresh_token TEXT,
       expiry        BIGINT,
       scope         TEXT,
       connected_at  BIGINT
     )`,
    `CREATE TABLE IF NOT EXISTS google_sheets (
       id             VARCHAR(50) PRIMARY KEY,
       account_id     VARCHAR(50) NOT NULL,
       name           VARCHAR(150),
       spreadsheet_id VARCHAR(120),
       url            TEXT,
       created_at     BIGINT,
       INDEX idx_gsheets_acc (account_id)
     )`,
    "ALTER TABLE ai_tools ADD COLUMN action_type VARCHAR(20) DEFAULT 'variable'",
    "ALTER TABLE conversations     ADD COLUMN assigned_to JSON",
    // Contador de mensajes no leídos por conversación (para la burbuja del móvil).
    "ALTER TABLE conversations     ADD COLUMN unread_count INT DEFAULT 0",
    // Motivo por el que la IA quedó desactivada en un chat (p. ej. límite de
    // respuestas IA por conversación en Demo). Solo lo ven los administradores.
    "ALTER TABLE conversations     ADD COLUMN ai_disabled_reason VARCHAR(40)",
    // Origen del lead (anuncio/link/directo + plataforma + id de anuncio + UTM).
    "ALTER TABLE conversations     ADD COLUMN origin JSON",
    // Conexión de tienda (WooCommerce/Shopify) por cuenta.
    "ALTER TABLE accounts          ADD COLUMN woocommerce JSON",
    // Memoria PERMANENTE del cliente (resumen + estado), acumulada entre todas sus
    // conversaciones. Se inyecta en el prompt además de los últimos 16 mensajes.
    "ALTER TABLE contacts          ADD COLUMN memory TEXT",
    "ALTER TABLE contacts          ADD COLUMN memory_updated_at BIGINT",
    // Herramienta IA de agenda: calendarios que el asistente puede usar para ver
    // disponibilidad / agendar / mover / cancelar citas.
    "ALTER TABLE accounts          ADD COLUMN scheduling JSON",
    // Pedidos creados por el asistente → mapeo pedido↔conversación para confirmar el pago.
    `CREATE TABLE IF NOT EXISTS woo_orders (
       id          VARCHAR(60)  PRIMARY KEY,
       account_id  VARCHAR(50)  NOT NULL,
       agent_id    VARCHAR(50),
       conv_id     VARCHAR(80),
       platform    VARCHAR(20)  DEFAULT 'woocommerce',
       order_id    VARCHAR(40)  NOT NULL,
       order_key   VARCHAR(80),
       status      VARCHAR(30)  DEFAULT 'pending',
       total       VARCHAR(30),
       currency    VARCHAR(10),
       pay_url     TEXT,
       paid_notified TINYINT(1) DEFAULT 0,
       reminders_sent TINYINT(1) DEFAULT 0,
       last_reminder_at BIGINT,
       created_at  BIGINT,
       updated_at  BIGINT,
       INDEX idx_woo_order (account_id, order_id),
       INDEX idx_woo_conv (account_id, conv_id)
     )`,
    // Columnas añadidas a woo_orders en instalaciones que ya tenían la tabla.
    "ALTER TABLE woo_orders ADD COLUMN platform VARCHAR(20) DEFAULT 'woocommerce'",
    "ALTER TABLE woo_orders ADD COLUMN reminders_sent TINYINT(1) DEFAULT 0",
    "ALTER TABLE woo_orders ADD COLUMN last_reminder_at BIGINT",
    // Pasarela de pago general (Wompi …): config por cuenta.
    "ALTER TABLE accounts ADD COLUMN payments JSON",
    // Tokens de push de la app móvil (Expo). Un token por dispositivo/cuenta.
    `CREATE TABLE IF NOT EXISTS push_tokens (
       id          VARCHAR(40) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       member_id   VARCHAR(50),
       token       VARCHAR(255) NOT NULL,
       platform    VARCHAR(20),
       created_at  BIGINT,
       updated_at  BIGINT,
       UNIQUE KEY uq_push_token (token),
       INDEX idx_push_acc (account_id)
     )`,
    // Intentos de pago creados por el asistente → mapeo pago↔conversación para
    // confirmar el pago (webhook) y disparar el flujo de éxito/fallo.
    `CREATE TABLE IF NOT EXISTS payment_intents (
       id            VARCHAR(60)  PRIMARY KEY,
       account_id    VARCHAR(50)  NOT NULL,
       agent_id      VARCHAR(50),
       conv_id       VARCHAR(80),
       provider      VARCHAR(20)  DEFAULT 'wompi',
       reference     VARCHAR(80)  NOT NULL,
       link_id       VARCHAR(80),
       link_url      TEXT,
       amount        DECIMAL(14,2),
       currency      VARCHAR(10),
       description   VARCHAR(255),
       status        VARCHAR(20)  DEFAULT 'pending',
       transaction_id VARCHAR(80),
       result_notified TINYINT(1) DEFAULT 0,
       created_at    BIGINT,
       updated_at    BIGINT,
       UNIQUE KEY uq_pi_ref (account_id, reference),
       INDEX idx_pi_link (account_id, link_id),
       INDEX idx_pi_conv (account_id, conv_id)
     )`,
    `CREATE TABLE IF NOT EXISTS crm_notes (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       target_type VARCHAR(20) NOT NULL,
       target_id   VARCHAR(80) NOT NULL,
       author_id   VARCHAR(50), author_name VARCHAR(100),
       content     TEXT, ts BIGINT,
       INDEX idx_notes_target (account_id, target_type, target_id, ts)
     )`,
    `CREATE TABLE IF NOT EXISTS crm_tasks (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL,
       target_type   VARCHAR(20), target_id VARCHAR(80),
       title VARCHAR(200), description TEXT, due_at BIGINT,
       assignee_id VARCHAR(50), assignee_name VARCHAR(100),
       status VARCHAR(20) DEFAULT 'open', priority VARCHAR(20) DEFAULT 'normal',
       created_by VARCHAR(100), created_at BIGINT, completed_at BIGINT,
       INDEX idx_tasks_target (account_id, target_type, target_id),
       INDEX idx_tasks_assignee (account_id, assignee_id, status)
     )`,
    `CREATE TABLE IF NOT EXISTS crm_activity (
       id BIGINT PRIMARY KEY AUTO_INCREMENT,
       account_id VARCHAR(50) NOT NULL,
       target_type VARCHAR(20) NOT NULL, target_id VARCHAR(80) NOT NULL,
       kind VARCHAR(30), title VARCHAR(200), detail TEXT,
       author_id VARCHAR(50), author_name VARCHAR(100), ts BIGINT,
       INDEX idx_act_target (account_id, target_type, target_id, ts)
     )`,
    `CREATE TABLE IF NOT EXISTS quick_replies (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       shortcut    VARCHAR(50),
       title       VARCHAR(100),
       content     TEXT,
       created_by  VARCHAR(50),
       created_at  BIGINT,
       INDEX idx_qr_acc (account_id)
     )`,
    `CREATE TABLE IF NOT EXISTS media (
       id              VARCHAR(50) PRIMARY KEY,
       account_id      VARCHAR(50) NOT NULL,
       conversation_id VARCHAR(80) NOT NULL,
       message_id      VARCHAR(50),
       kind            VARCHAR(20),
       mime_type       VARCHAR(100),
       filename        VARCHAR(255),
       size_bytes      INT,
       data_base64     LONGTEXT,
       ts              BIGINT,
       INDEX idx_media_conv (conversation_id, ts)
     )`,
    "ALTER TABLE platform_settings ADD COLUMN prompt_generator_conditions TEXT",
    "ALTER TABLE platform_settings ADD COLUMN prompt_generator_max_tokens INT DEFAULT 8000",
    "ALTER TABLE platform_settings ADD COLUMN prompt_generator_temperature DECIMAL(3,2) DEFAULT 0.55",
    "ALTER TABLE platform_settings ADD COLUMN prompt_generator_max_doc_chars INT DEFAULT 200000",
    "ALTER TABLE platform_settings ADD COLUMN openai_key TEXT",
    "ALTER TABLE platform_settings ADD COLUMN deepseek_key TEXT",
    "ALTER TABLE platform_settings ADD COLUMN anthropic_key TEXT",
    "ALTER TABLE backups ADD COLUMN type VARCHAR(10) DEFAULT 'master'",
    // Modelo por defecto para PROMPTS nuevos (solo lo cambia el super admin).
    "ALTER TABLE platform_settings ADD COLUMN default_prompt_provider VARCHAR(20) DEFAULT 'deepseek'",
    "ALTER TABLE platform_settings ADD COLUMN default_prompt_model VARCHAR(60) DEFAULT 'deepseek-v4-flash'",
    "ALTER TABLE agents ADD COLUMN fallback_flow_id VARCHAR(50)",
    "ALTER TABLE agents ADD COLUMN test_flow_id VARCHAR(50)",
    "ALTER TABLE team_chat ADD COLUMN media JSON",
    "ALTER TABLE support_messages ADD COLUMN media JSON",
    `CREATE TABLE IF NOT EXISTS team_channels (
       id          VARCHAR(80) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       name        VARCHAR(100),
       type        VARCHAR(20) DEFAULT 'channel',
       members     JSON,
       created_by  VARCHAR(50),
       created_at  BIGINT,
       updated_at  BIGINT,
       INDEX idx_tch_acc (account_id, type)
     )`,
    `CREATE TABLE IF NOT EXISTS prompt_change_history (
       id BIGINT PRIMARY KEY AUTO_INCREMENT,
       account_id VARCHAR(50) NOT NULL,
       agent_id VARCHAR(50),
       prompt_id VARCHAR(50),
       prompt_name VARCHAR(100),
       user_id VARCHAR(50),
       user_name VARCHAR(100),
       instruction TEXT,
       category VARCHAR(20),
       was_edited_manually TINYINT(1) DEFAULT 0,
       old_content MEDIUMTEXT,
       new_content MEDIUMTEXT,
       input_tokens INT DEFAULT 0,
       output_tokens INT DEFAULT 0,
       total_tokens INT DEFAULT 0,
       cost_usd DECIMAL(12,6) DEFAULT 0,
       model VARCHAR(80),
       provider VARCHAR(20),
       backup_id VARCHAR(50),
       ts BIGINT,
       INDEX idx_pch_acc (account_id, ts),
       INDEX idx_pch_agent (account_id, agent_id, ts)
     )`,
    `CREATE TABLE IF NOT EXISTS tutorials (
       id          VARCHAR(50) PRIMARY KEY,
       title       VARCHAR(200) NOT NULL,
       category    VARCHAR(50) DEFAULT 'general',
       excerpt     TEXT,
       content     LONGTEXT,
       thumbnail   TEXT,
       published   TINYINT(1) DEFAULT 1,
       sort_order  INT DEFAULT 0,
       created_at  BIGINT,
       updated_at  BIGINT
     )`,
    // ── Calendarios (reservas + formularios) ──────────────────────────────
    `CREATE TABLE IF NOT EXISTS calendars (
       id           VARCHAR(50) PRIMARY KEY,
       account_id   VARCHAR(50) NOT NULL,
       type         VARCHAR(20) DEFAULT 'booking',   -- booking | form
       name         VARCHAR(150) NOT NULL,
       description  TEXT,
       timezone     VARCHAR(64) DEFAULT 'America/Lima',
       color        VARCHAR(20) DEFAULT '#7c6fff',
       status       VARCHAR(20) DEFAULT 'active',     -- active | inactive
       availability JSON,    -- { mon:{enabled,slots:[{start,end}]}, ... }
       exceptions   JSON,    -- [{ date, type:'block'|'custom', slots:[{start,end}], note }]
       appointment  JSON,    -- { defaultDuration, types, buffer, maxPerDay, minAdvanceMin, maxAdvanceDays, allowSimultaneous, capacity }
       form_config  JSON,    -- type=form: { fields:[...], scheduleStepEnabled, whatsappConsent, intro }
       flow_id      VARCHAR(50),  -- flujo a ejecutar al crear la reserva
       created_at   BIGINT,
       updated_at   BIGINT,
       INDEX idx_cal_acc (account_id, status)
     )`,
    "ALTER TABLE calendars ADD COLUMN notifications JSON",
    "ALTER TABLE calendars ADD COLUMN integrations JSON",
    `CREATE TABLE IF NOT EXISTS calendar_bookings (
       id           VARCHAR(50) PRIMARY KEY,
       account_id   VARCHAR(50) NOT NULL,
       calendar_id  VARCHAR(50) NOT NULL,
       date         VARCHAR(10),   -- YYYY-MM-DD (wall-clock en la TZ del calendario)
       time         VARCHAR(5),    -- HH:MM
       duration     INT DEFAULT 30,
       client_name  VARCHAR(150),
       client_phone VARCHAR(40),
       client_email VARCHAR(150),
       channel      VARCHAR(30) DEFAULT 'manual',
       status       VARCHAR(20) DEFAULT 'pending',  -- pending|confirmed|rescheduled|cancelled|noshow|completed
       notes        TEXT,
       meta         JSON,          -- respuestas del formulario, consentimiento WhatsApp, etc.
       external_id  VARCHAR(200),  -- id del evento en Google/Zoho (sync futura)
       created_at   BIGINT,
       updated_at   BIGINT,
       INDEX idx_book_cal_date (account_id, calendar_id, date),
       INDEX idx_book_status (account_id, status),
       INDEX idx_book_ext (external_id)
     )`,
    // ── App global de Meta para Embedded Signup / Coexistencia de WhatsApp ──
    "ALTER TABLE platform_settings ADD COLUMN meta_app_secret TEXT",
    "ALTER TABLE platform_settings ADD COLUMN meta_config_id VARCHAR(64) DEFAULT ''",
    // ── Modelo para transcripción de audios (OpenAI) ──
    "ALTER TABLE platform_settings ADD COLUMN transcription_model VARCHAR(50) DEFAULT 'whisper-1'",
    // Aviso por defecto para la IA cuando escribe un cliente recurrente. Editable por
    // el super admin; cada cuenta puede sobrescribirlo por canal. NULL = usar default.
    "ALTER TABLE platform_settings ADD COLUMN returning_notice_default TEXT",
    // Credenciales OAuth GLOBALES de Google (una sola app cubre Calendar + Sheets).
    // El super admin las pone aquí; cada cuenta solo hace "Conectar con Google".
    "ALTER TABLE platform_settings ADD COLUMN google_client_id VARCHAR(200)",
    "ALTER TABLE platform_settings ADD COLUMN google_client_secret VARCHAR(255)",
    "ALTER TABLE platform_settings ADD COLUMN google_redirect_uri VARCHAR(300)",
    // Conexiones de Google MULTI-cuenta: una fila por cada cuenta de Google que la
    // cuenta conecte (antes era una sola por account_id). Cada calendario elige con
    // qué conexión sincroniza (integrations.google.connectionId).
    `CREATE TABLE IF NOT EXISTS google_connections (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL,
       email         VARCHAR(200),
       access_token  TEXT,
       refresh_token TEXT,
       expiry        BIGINT,
       scope         TEXT,
       connected_at  BIGINT,
       UNIQUE KEY uq_gc_acc_email (account_id, email),
       INDEX idx_gc_acc (account_id)
     )`,
    // Backfill idempotente desde la tabla vieja (una conexión por cuenta → nueva tabla).
    `INSERT INTO google_connections (id, account_id, email, access_token, refresh_token, expiry, scope, connected_at)
       SELECT CONCAT('gc_', account_id), account_id, COALESCE(email,''), access_token, refresh_token, expiry, scope, connected_at
       FROM google_integrations
       ON DUPLICATE KEY UPDATE email=google_connections.email`,
    // ── FASE 0: núcleo multi-industria (no disruptivo) ──────────────────────
    // Vertical del calendario (medical|restaurant|hotel|cinema|appointment).
    // Default 'appointment' = comportamiento actual (time-slot + Google sync).
    "ALTER TABLE calendars ADD COLUMN vertical VARCHAR(20) DEFAULT 'appointment'",
    // Grupo de espacios compartidos: calendarios del MISMO grupo (y mismo
    // vertical) se excluyen mutuamente en franjas que se solapan en el tiempo,
    // para no superponer citas entre ellos. NULL = no comparte espacios.
    "ALTER TABLE calendars ADD COLUMN shared_group VARCHAR(80) DEFAULT NULL",
    // Pago previo: config de pasarela por calendario (enabled, amount, currency, description, holdMinutes).
    "ALTER TABLE calendars ADD COLUMN payment JSON",
    // Outbox de eventos de dominio (microservices-ready).
    `CREATE TABLE IF NOT EXISTS domain_events (
       id          BIGINT PRIMARY KEY AUTO_INCREMENT,
       account_id  VARCHAR(50),
       agent_id    VARCHAR(50),
       vertical    VARCHAR(20) DEFAULT 'appointment',
       type        VARCHAR(50) NOT NULL,
       aggregate_id VARCHAR(50),
       payload     JSON,
       status      VARCHAR(12) DEFAULT 'pending',   -- pending|done|error
       attempts    INT DEFAULT 0,
       ts          BIGINT,
       processed_at BIGINT,
       INDEX idx_evt_status (status, id),
       INDEX idx_evt_acc (account_id, type, ts)
     )`,
    // ── FASE 1: Núcleo + Médico formalizado ─────────────────────────────────
    // Cliente/paciente/huésped como entidad de primer nivel (+ historial).
    `CREATE TABLE IF NOT EXISTS customers (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       name        VARCHAR(150),
       phone       VARCHAR(40),
       email       VARCHAR(150),
       doc_id      VARCHAR(60),
       profile     JSON,            -- aseguradora, referencia, preferencias, alergias…
       created_at  BIGINT, updated_at BIGINT,
       INDEX idx_cust_phone (account_id, phone),
       INDEX idx_cust_email (account_id, email)
     )`,
    "ALTER TABLE calendar_bookings ADD COLUMN customer_id VARCHAR(50)",
    // Asignación reserva ↔ unidad de inventario (1..N). Médico: 1:1 (slot del
    // calendario). El UNIQUE es el seguro anti doble-reserva a nivel de BD.
    `CREATE TABLE IF NOT EXISTS booking_allocations (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       booking_id  VARCHAR(50) NOT NULL,
       resource_id VARCHAR(50),          -- médico: el calendarId (agenda)
       unit_key    VARCHAR(120),         -- médico: 'YYYY-MM-DDTHH:MM#seat'
       slot_start  DATETIME, slot_end DATETIME,
       qty         INT DEFAULT 1, meta JSON,
       UNIQUE KEY uq_alloc_unit (account_id, resource_id, unit_key),
       INDEX idx_alloc_bk (booking_id)
     )`,
    // Bloqueos temporales con expiración (holds). Núcleo para cine/restaurante;
    // disponible desde ya para evitar dobles reservas en ventanas de pago.
    `CREATE TABLE IF NOT EXISTS holds (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       vertical    VARCHAR(20),
       resource_id VARCHAR(50), unit_key VARCHAR(120),
       slot_start  DATETIME, expires_at BIGINT, session_id VARCHAR(80),
       UNIQUE KEY uq_hold_unit (account_id, resource_id, unit_key),
       INDEX idx_hold_exp (expires_at)
     )`,
    // ── FASE 2: Restaurante (CapacityStrategy) ──────────────────────────────
    "ALTER TABLE calendar_bookings ADD COLUMN party_size INT DEFAULT 1",
    `CREATE TABLE IF NOT EXISTS rest_tables (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       name        VARCHAR(60),
       area        VARCHAR(20) DEFAULT 'indoor',   -- indoor|terrace|vip|bar
       cap_min     INT DEFAULT 1, cap_max INT DEFAULT 2,
       joinable    TINYINT DEFAULT 1, sort_order INT DEFAULT 0,
       status      VARCHAR(20) DEFAULT 'active',
       created_at  BIGINT, updated_at BIGINT,
       INDEX idx_rtbl (account_id, calendar_id, status)
     )`,
    `CREATE TABLE IF NOT EXISTS rest_shifts (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       name        VARCHAR(40),
       start_time  VARCHAR(5), end_time VARCHAR(5),
       avg_occupancy_min INT DEFAULT 90, slot_every_min INT DEFAULT 15,
       days        JSON,                            -- ['mon',...] o null=todos
       sort_order  INT DEFAULT 0, created_at BIGINT, updated_at BIGINT,
       INDEX idx_rsh (account_id, calendar_id)
     )`,
    `CREATE TABLE IF NOT EXISTS rest_waitlist (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       date        VARCHAR(10), time VARCHAR(5), shift_id VARCHAR(50),
       party_size  INT, customer_id VARCHAR(50),
       client_name VARCHAR(150), client_phone VARCHAR(40),
       status      VARCHAR(20) DEFAULT 'waiting',   -- waiting|notified|seated|cancelled|expired
       notes       TEXT, created_at BIGINT, updated_at BIGINT,
       INDEX idx_wl (account_id, calendar_id, date, status)
     )`,
    // ── FASE 3: Cine (SeatMapStrategy) ──────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS cine_movies (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       title       VARCHAR(200), duration_min INT, rating VARCHAR(10),
       poster      TEXT, synopsis TEXT, status VARCHAR(20) DEFAULT 'active',
       created_at  BIGINT, updated_at BIGINT,
       INDEX idx_movie (account_id, calendar_id, status)
     )`,
    `CREATE TABLE IF NOT EXISTS cine_auditoriums (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       name        VARCHAR(80), screen_type VARCHAR(10) DEFAULT '2D',  -- 2D|3D|IMAX|VIP
       seat_map    JSON,   -- { rows:[{row:'A',count:12,type:'standard'}], blocked:['A1'] }
       created_at  BIGINT, updated_at BIGINT,
       INDEX idx_aud (account_id, calendar_id)
     )`,
    `CREATE TABLE IF NOT EXISTS cine_showtimes (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       movie_id    VARCHAR(50), auditorium_id VARCHAR(50),
       date        VARCHAR(10), time VARCHAR(5),
       format      VARCHAR(10), language VARCHAR(20), price DECIMAL(10,2),
       status      VARCHAR(20) DEFAULT 'active',
       created_at  BIGINT, updated_at BIGINT,
       INDEX idx_show (account_id, calendar_id, date),
       INDEX idx_show_movie (account_id, movie_id, date)
     )`,
    // ── FASE 4a: Hotel PMS (InventoryStrategy room-nights) ──────────────────
    "ALTER TABLE calendar_bookings ADD COLUMN checkout VARCHAR(10)",
    `CREATE TABLE IF NOT EXISTS hotel_room_types (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       name          VARCHAR(120), base_capacity INT DEFAULT 2, max_capacity INT DEFAULT 2,
       total_rooms   INT DEFAULT 1, overbook_limit INT DEFAULT 0,
       base_price    DECIMAL(12,2) DEFAULT 0, currency VARCHAR(3) DEFAULT 'USD',
       amenities     JSON, status VARCHAR(20) DEFAULT 'active',
       created_at    BIGINT, updated_at BIGINT,
       INDEX idx_rt (account_id, calendar_id, status)
     )`,
    // Tarifas por noche (temporadas / fechas con precio distinto al base).
    `CREATE TABLE IF NOT EXISTS hotel_rate_overrides (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, room_type_id VARCHAR(50) NOT NULL,
       date          VARCHAR(10), price DECIMAL(12,2),
       UNIQUE KEY uq_rate (account_id, room_type_id, date)
     )`,
    // ── FASE 4b-4e: PMS operativo (recepción, HK, mantenimiento, folios) ────
    "ALTER TABLE calendar_bookings ADD COLUMN room_id VARCHAR(50)",
    `CREATE TABLE IF NOT EXISTS hotel_rooms (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       room_type_id  VARCHAR(50), number VARCHAR(20), floor INT,
       hk_status     VARCHAR(20) DEFAULT 'clean',   -- clean|dirty|inspected|oos
       status        VARCHAR(20) DEFAULT 'active',
       created_at    BIGINT, updated_at BIGINT,
       INDEX idx_room (account_id, calendar_id, room_type_id)
     )`,
    `CREATE TABLE IF NOT EXISTS hk_tasks (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       room_id       VARCHAR(50), type VARCHAR(20) DEFAULT 'cleaning',
       status        VARCHAR(20) DEFAULT 'pending',  -- pending|in_progress|done
       assignee      VARCHAR(100), date VARCHAR(10), notes TEXT,
       created_at    BIGINT, updated_at BIGINT,
       INDEX idx_hk (account_id, calendar_id, status, date)
     )`,
    `CREATE TABLE IF NOT EXISTS maintenance_tickets (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       room_id       VARCHAR(50), issue TEXT, severity VARCHAR(10) DEFAULT 'low',
       status        VARCHAR(20) DEFAULT 'open',     -- open|resolved
       oos_from      VARCHAR(10), oos_to VARCHAR(10),
       created_at    BIGINT, updated_at BIGINT,
       INDEX idx_mnt (account_id, calendar_id, status)
     )`,
    `CREATE TABLE IF NOT EXISTS hotel_folios (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, booking_id VARCHAR(50) NOT NULL,
       status        VARCHAR(20) DEFAULT 'open',     -- open|closed
       currency      VARCHAR(3) DEFAULT 'USD',
       created_at    BIGINT, updated_at BIGINT,
       UNIQUE KEY uq_folio_bk (account_id, booking_id)
     )`,
    `CREATE TABLE IF NOT EXISTS hotel_folio_lines (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, folio_id VARCHAR(50) NOT NULL,
       kind          VARCHAR(20) DEFAULT 'charge',   -- room|fnb|spa|tax|other
       description   VARCHAR(200), amount DECIMAL(12,2), tax DECIMAL(12,2) DEFAULT 0,
       ts            BIGINT,
       INDEX idx_fl (account_id, folio_id)
     )`,
    `CREATE TABLE IF NOT EXISTS hotel_payments (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, folio_id VARCHAR(50) NOT NULL,
       method        VARCHAR(20), amount DECIMAL(12,2), currency VARCHAR(3) DEFAULT 'USD',
       is_deposit    TINYINT DEFAULT 0, ts BIGINT,
       INDEX idx_pay (account_id, folio_id)
     )`,
    // ── Canales / OTAs del hotel (Airbnb, HosRoom, Booking, Kunas) ──────────
    "ALTER TABLE calendar_bookings ADD COLUMN channel_ref VARCHAR(150)",
    "ALTER TABLE calendar_bookings ADD COLUMN ical_uid VARCHAR(200)",
    // Habitaciones: ficha completa (descripción, fotos) + mapeo a listado externo.
    "ALTER TABLE hotel_room_types ADD COLUMN description TEXT",
    "ALTER TABLE hotel_room_types ADD COLUMN photos JSON",
    "ALTER TABLE hotel_room_types ADD COLUMN external_provider VARCHAR(20)",
    "ALTER TABLE hotel_room_types ADD COLUMN external_ref VARCHAR(150)",
    `CREATE TABLE IF NOT EXISTS hotel_channels (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL, calendar_id VARCHAR(50) NOT NULL,
       provider      VARCHAR(20) NOT NULL,   -- airbnb|hosroom|booking|kunas
       name          VARCHAR(120), enabled TINYINT DEFAULT 1,
       config        JSON,   -- { icalImportUrl, apiKey, endpoint, propertyId, roomTypeId, roomTypeMap, webhookSecret }
       last_sync     BIGINT, last_result TEXT,
       created_at    BIGINT, updated_at BIGINT,
       INDEX idx_chan (account_id, calendar_id, provider)
     )`,
    // CMS: biblioteca de recursos (imágenes/documentos) que el asistente IA puede
    // enviar en conversaciones. media_id apunta a la tabla media (bytes reales).
    `CREATE TABLE IF NOT EXISTS cms_assets (
       id            VARCHAR(50) PRIMARY KEY,
       account_id    VARCHAR(50) NOT NULL,
       name          VARCHAR(180) NOT NULL,
       description   TEXT,
       tags          JSON,
       kind          VARCHAR(20),    -- image|video|audio|file
       media_id      VARCHAR(60),
       filename      VARCHAR(255),
       mime          VARCHAR(150),
       size_bytes    BIGINT,
       rag_file_id   VARCHAR(60),    -- si el documento se indexó en Conocimiento (RAG)
       rag_agent_id  VARCHAR(60),
       created_at    BIGINT,
       INDEX idx_cms_acc (account_id)
     )`,
    // CMS: carpetas (simple | unit=super unidad/producto), etiquetas y categorías
    // globales para parametrizar la biblioteca.
    "ALTER TABLE cms_assets ADD COLUMN folder_id VARCHAR(50)",
    "ALTER TABLE cms_assets ADD COLUMN category VARCHAR(120)",
    `CREATE TABLE IF NOT EXISTS cms_folders (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       name        VARCHAR(180) NOT NULL,
       type        VARCHAR(20) DEFAULT 'simple',   -- simple | unit
       description TEXT,
       created_at  BIGINT,
       INDEX idx_cmsfolder_acc (account_id)
     )`,
    `CREATE TABLE IF NOT EXISTS cms_tags (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       name        VARCHAR(80) NOT NULL,
       created_at  BIGINT,
       INDEX idx_cmstag_acc (account_id)
     )`,
    `CREATE TABLE IF NOT EXISTS cms_categories (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       name        VARCHAR(120) NOT NULL,
       created_at  BIGINT,
       INDEX idx_cmscat_acc (account_id)
     )`,
    // CMS · división PRODUCTOS/CATÁLOGO: a diferencia de los assets (archivos
    // sueltos), un producto tiene nombre, precio, varias fotos, categorías y
    // atributos personalizados (pares nombre/valor definidos por el negocio).
    `CREATE TABLE IF NOT EXISTS cms_products (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       name        VARCHAR(200) NOT NULL,
       description TEXT,
       price       DECIMAL(12,2) DEFAULT 0,
       currency    VARCHAR(8) DEFAULT 'COP',
       photos      JSON,   -- [mediaId, …]
       categories  JSON,   -- [nombreCategoria, …]
       attributes  JSON,   -- [{ name, value }, …]  (atributos personalizados)
       active      TINYINT(1) DEFAULT 1,
       sort        INT DEFAULT 0,
       created_at  BIGINT,
       updated_at  BIGINT,
       INDEX idx_cmsprod_acc (account_id)
     )`,
    // Biblioteca de stickers (imágenes) para enviar rápido en los chats. media_id
    // apunta a la tabla media.
    `CREATE TABLE IF NOT EXISTS stickers (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       media_id    VARCHAR(60),
       mime        VARCHAR(120),
       name        VARCHAR(120),
       created_at  BIGINT,
       INDEX idx_sticker_acc (account_id)
     )`,
    // Filtros guardados del inbox: globales (toda la cuenta, sólo el owner) o
    // personales (por miembro). payload guarda la definición del filtro.
    `CREATE TABLE IF NOT EXISTS saved_filters (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50) NOT NULL,
       owner_id    VARCHAR(50),
       scope       VARCHAR(10) DEFAULT 'personal',  -- global | personal
       name        VARCHAR(120) NOT NULL,
       payload     JSON,
       created_at  BIGINT,
       INDEX idx_sf_acc (account_id)
     )`,
    // Mensajes masivos: una campaña ejecuta un FLUJO (que lleva la plantilla) sobre
    // una audiencia filtrada, opcionalmente programada para una fecha.
    `CREATE TABLE IF NOT EXISTS campaigns (
       id           VARCHAR(50) PRIMARY KEY,
       account_id   VARCHAR(50) NOT NULL,
       agent_id     VARCHAR(50),
       name         VARCHAR(150),
       channel      VARCHAR(20) DEFAULT 'whatsapp',
       flow_id      VARCHAR(50),
       audience     JSON,
       scheduled_at BIGINT,
       status       VARCHAR(20) DEFAULT 'draft',  -- draft|scheduled|sending|done|cancelled
       stats        JSON,
       sent_at      BIGINT,
       created_at   BIGINT,
       INDEX idx_camp_acc (account_id)
     )`,
    // Destinatarios reales de la campaña (ids de contacto) para atribuir ingresos (ROI).
    "ALTER TABLE campaigns ADD COLUMN recipients JSON",
    // Intentos de pago: metadatos genéricos (p. ej. link a una reserva de calendario).
    "ALTER TABLE payment_intents ADD COLUMN meta JSON",
    // A/B testing de masivos: flujo variante B + % de audiencia asignado a B + resultado por grupo.
    "ALTER TABLE campaigns ADD COLUMN variant_flow_id VARCHAR(50)",
    "ALTER TABLE campaigns ADD COLUMN ab_split INT",
    "ALTER TABLE campaigns ADD COLUMN ab_groups JSON",
    // ── Suscripciones: tipos de cuenta, planes mensuales y suscripción por cuenta ──
    `CREATE TABLE IF NOT EXISTS account_types (
       id                                    VARCHAR(50) PRIMARY KEY,
       name                                  VARCHAR(80) NOT NULL,
       max_webchat_channels                  INT DEFAULT 1,
       max_whatsapp_channels                 INT DEFAULT 1,
       max_test_channels                     INT DEFAULT 1,
       max_messenger_channels                INT DEFAULT 0,
       max_instagram_channels                INT DEFAULT 0,
       is_demo                               TINYINT(1) DEFAULT 0,
       demo_days_duration                    INT DEFAULT 7,
       demo_max_conversations                INT DEFAULT 100,
       demo_max_ai_responses_per_conversation INT DEFAULT 30,
       sort_order                            INT DEFAULT 0,
       created_at                            BIGINT,
       updated_at                            BIGINT
     )`,
    `CREATE TABLE IF NOT EXISTS subscription_plans (
       id                         VARCHAR(50) PRIMARY KEY,
       name                       VARCHAR(80) NOT NULL,
       monthly_conversation_limit INT DEFAULT 0,
       is_custom_limit            TINYINT(1) DEFAULT 0,
       grace_period_days          INT DEFAULT 5,
       sort_order                 INT DEFAULT 0,
       created_at                 BIGINT,
       updated_at                 BIGINT
     )`,
    `CREATE TABLE IF NOT EXISTS account_subscriptions (
       id                                VARCHAR(50) PRIMARY KEY,
       account_id                        VARCHAR(50) NOT NULL,
       account_type_id                   VARCHAR(50),
       subscription_plan_id              VARCHAR(50),
       custom_monthly_limit              INT DEFAULT NULL,   -- Enterprise: límite definido por cuenta
       conversation_count_current_period INT DEFAULT 0,
       current_period_start              BIGINT,
       current_period_end                BIGINT,
       grace_until                       BIGINT DEFAULT NULL,
       demo_started_at                   BIGINT DEFAULT NULL,
       demo_expires_at                   BIGINT DEFAULT NULL,
       last_alert_threshold              INT DEFAULT 0,      -- 0|80|90|100 (anti-duplicado de alertas)
       status                            VARCHAR(20) DEFAULT 'active', -- active|grace|suspended|expired
       created_at                        BIGINT,
       updated_at                        BIGINT,
       UNIQUE KEY uniq_sub_acc (account_id)
     )`,
    // ── Antifraude Demo: registro/auditoría de intentos + excepciones del superadmin ──
    `CREATE TABLE IF NOT EXISTS demo_registrations (
       id          VARCHAR(50) PRIMARY KEY,
       account_id  VARCHAR(50),
       email       VARCHAR(150),
       ip          VARCHAR(60),
       fingerprint VARCHAR(120),
       phone       VARCHAR(40),
       result      VARCHAR(30),   -- created|created_override|blocked_email|blocked_ip|blocked_fingerprint|blocked_phone
       reason      VARCHAR(200),
       status      VARCHAR(20) DEFAULT 'active', -- active|expired|converted
       created_at  BIGINT,
       expires_at  BIGINT,
       INDEX idx_dr_email (email), INDEX idx_dr_ip (ip),
       INDEX idx_dr_fp (fingerprint), INDEX idx_dr_phone (phone), INDEX idx_dr_created (created_at)
     )`,
    `CREATE TABLE IF NOT EXISTS demo_overrides (
       id         VARCHAR(50) PRIMARY KEY,
       kind       VARCHAR(20),   -- email|ip|fingerprint|phone|global_ip_off
       value      VARCHAR(150),
       note       VARCHAR(200),
       used       TINYINT(1) DEFAULT 0,
       created_by VARCHAR(100),
       created_at BIGINT,
       INDEX idx_do_kind (kind, value)
     )`,
    // Precio mensual del plan (para MRR / ingresos por plan en el dashboard comercial).
    "ALTER TABLE subscription_plans ADD COLUMN monthly_price DECIMAL(10,2) DEFAULT 0",
    // Datos del onboarding inteligente de la Demo (para métricas + generación de IA).
    "ALTER TABLE demo_registrations ADD COLUMN company VARCHAR(150)",
    "ALTER TABLE demo_registrations ADD COLUMN country VARCHAR(80)",
    "ALTER TABLE demo_registrations ADD COLUMN industry VARCHAR(80)",
    "ALTER TABLE demo_registrations ADD COLUMN ia_name VARCHAR(80)",
    "ALTER TABLE demo_registrations ADD COLUMN onboarding JSON",
    // Interruptor global del registro Demo (SuperAdmin).
    "ALTER TABLE platform_settings ADD COLUMN demo_registration_enabled TINYINT(1) DEFAULT 1",
    // Plantilla de Descubrimiento Empresarial (una activa a la vez).
    `CREATE TABLE IF NOT EXISTS demo_templates (
       id          VARCHAR(50) PRIMARY KEY,
       name        VARCHAR(150),
       filename    VARCHAR(200),
       mime        VARCHAR(120),
       ext         VARCHAR(10),
       size_bytes  INT,
       data_base64 LONGTEXT,
       active      TINYINT(1) DEFAULT 0,
       created_by  VARCHAR(120),
       created_at  BIGINT
     )`,
  ]
  for (const sql of migrations) {
    try { await pool.query(sql) } catch (e) { /* column exists or unsupported */ }
  }
  // Dedup de membresías: una identidad (email) solo debe tener UNA fila por cuenta.
  // Datos legados podían tener duplicados (p. ej. invitarse a una cuenta donde ya se era
  // miembro) → se fusiona el acceso a agentes en la fila que se conserva y se borran las demás.
  try {
    const [dups] = await pool.query(
      `SELECT account_id, email FROM members
       WHERE email IS NOT NULL AND email<>''
       GROUP BY account_id, email HAVING COUNT(*) > 1`
    )
    const safeArr = v => { try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : [] } catch { return [] } }
    for (const d of dups) {
      const [rows] = await pool.query('SELECT * FROM members WHERE account_id=? AND email=? ORDER BY (password IS NULL OR password=\'\'), id', [d.account_id, d.email])
      if (rows.length < 2) continue
      const keep = rows[0]
      const merged = [...new Set(rows.flatMap(r => safeArr(r.agent_access)))]
      await pool.query('UPDATE members SET agent_access=? WHERE id=?', [JSON.stringify(merged), keep.id])
      const drop = rows.slice(1).map(r => r.id)
      if (drop.length) await pool.query(`DELETE FROM members WHERE id IN (${drop.map(() => '?').join(',')})`, drop)
    }
    // Índice único para impedir futuros duplicados (email por cuenta).
    await pool.query('ALTER TABLE members ADD UNIQUE KEY uniq_members_acc_email (account_id, email)').catch(() => {})
  } catch (e) { console.warn('[members dedup] ', e.message) }
  // Seed default token limits if NULL
  try {
    await pool.query(
      "UPDATE platform_settings SET change_agent_token_limits=? WHERE id=1 AND change_agent_token_limits IS NULL",
      [JSON.stringify({ basic: 50000, medium: 30000, complex: 15000 })]
    )
  } catch {}
  // Suscripciones: siembra tipos de cuenta y planes por defecto + arranca el worker
  // (vencimiento de demos, reinicio mensual, periodos de gracia, suspensiones, alertas).
  try {
    const subs = require('./services/subscriptions')
    await subs.seedDefaults()
    subs.startWorker()
  } catch (e) { console.warn('[subscriptions] no iniciado:', e.message) }
  // Recontactos inteligentes: re-engancha conversaciones abandonadas.
  try { require('./services/recontact').startWorker() } catch (e) { console.warn('[recontact] worker no iniciado:', e.message) }
  // Webhook de Google Calendar en tiempo real: registra/renueva canales push.
  try { require('./services/googleCalendarWatch').startWorker() } catch (e) { console.warn('[gcal watch] worker no iniciado:', e.message) }
  // Bucle de recordatorios de citas por WhatsApp
  try { require('./services/calendarReminders').start() } catch (e) { console.warn('[reminders] no iniciado:', e.message) }
  // Libera reservas con pago previo que vencieron sin pagarse (devuelve el cupo)
  try { require('./services/bookings').startPaymentSweeper() } catch (e) { console.warn('[booking pay sweeper] no iniciado:', e.message) }
  // Recuperación de carritos / confirmación de pago de la tienda (Woo + Shopify)
  try { require('./services/storeRecovery').start() } catch (e) { console.warn('[store recovery] no iniciado:', e.message) }
  // Worker de mensajes masivos: procesa campañas programadas vencidas.
  try { require('./services/campaigns').startWorker() } catch (e) { console.warn('[campaigns] worker no iniciado:', e.message) }
  // Reglas/playbooks del CRM: evalúa disparadores y crea tareas automáticamente.
  try { require('./services/crmRules').startWorker() } catch (e) { console.warn('[crm rules] worker no iniciado:', e.message) }
  // Procesador del outbox de eventos de dominio (Core Booking Engine, Fase 0)
  try { require('./core/events').startProcessor() } catch (e) { console.warn('[events] no iniciado:', e.message) }
  // Worker que libera los holds (bloqueos de asiento) vencidos — Cine (Fase 3)
  try {
    const cinema = require('./services/cinema')
    setInterval(() => { cinema.releaseExpiredHolds().catch(() => {}) }, 30000).unref?.()
    console.log('[holds] worker de liberación iniciado')
  } catch (e) { console.warn('[holds] worker no iniciado:', e.message) }
  // Worker de sincronización de canales/OTAs del hotel (iCal pull) cada 15 min.
  try {
    const channels = require('./services/hotelChannels')
    setInterval(() => { channels.syncAll().catch(() => {}) }, 15 * 60000).unref?.()
    setTimeout(() => { channels.syncAll().catch(() => {}) }, 60000).unref?.() // primer pull al minuto
    console.log('[channels] worker de sincronización iniciado')
  } catch (e) { console.warn('[channels] worker no iniciado:', e.message) }
})()

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`)
  console.log(`║  AVI Server — puerto ${PORT}                                 ║`)
  console.log(`║  REST API:   http://localhost:${PORT}/api                    ║`)
  console.log(`║  Socket.io:  ws://localhost:${PORT}                          ║`)
  console.log(`║  DB:         ${(process.env.DB_NAME || 'avi_platform').padEnd(37)}║`)
  console.log(`╚══════════════════════════════════════════════════════════╝\n`)
})
