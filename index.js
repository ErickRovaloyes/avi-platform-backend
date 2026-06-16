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
app.use(express.json({ limit: '10mb' }))

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
const promptGenRoutes     = require('./routes/promptGenerator.routes')
const promptHistoryRoutes = require('./routes/promptHistory.routes')
const mediaRoutes         = require('./routes/media.routes')
const quickRepliesRoutes  = require('./routes/quickReplies.routes')
const crmRoutes           = require('./routes/crm.routes')
const contactsRoutes      = require('./routes/contacts.routes')
const n8nRoutes           = require('./routes/n8nIntegrations.routes')
const apiKeysRoutes       = require('./routes/apiKeys.routes')
const publicApiRoutes     = require('./routes/publicApi.routes')
const analyticsRoutes     = require('./routes/analytics.routes')
const tutorialsRoutes     = require('./routes/tutorials.routes')
const waTemplatesRoutes   = require('./routes/whatsappTemplates.routes')
const googleRoutes        = require('./routes/google.routes')
const flowLogsRoutes      = require('./routes/flowLogs.routes')
const aiMediaRoutes       = require('./routes/aiMedia.routes')
const calendarRoutes      = require('./routes/calendars.routes')

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
app.use('/api',                n8nRoutes)
app.use('/api',                apiKeysRoutes)
app.use('/api',                publicApiRoutes)
app.use('/api',                analyticsRoutes)
app.use('/api',                tutorialsRoutes)
app.use('/api',                waTemplatesRoutes)
app.use('/api',                googleRoutes)
app.use('/api',                flowLogsRoutes)
app.use('/api',                aiMediaRoutes)
app.use('/api',                calendarRoutes)
app.use('/api',                webhookRoutes)

// ── Auto-migrate DB columns added after initial schema ────────────────────────
;(async () => {
  const pool = require('./db')
  // ADD COLUMN IF NOT EXISTS only works in MySQL 8.0.29+ — use ADD COLUMN and swallow "duplicate column" errors
  const migrations = [
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
    `CREATE TABLE IF NOT EXISTS n8n_integrations (
       id          VARCHAR(50) PRIMARY KEY,
       scope       VARCHAR(20),
       account_id  VARCHAR(50),
       name        VARCHAR(100),
       webhook_url TEXT,
       auth_type   VARCHAR(20) DEFAULT 'none',
       auth_value  TEXT,
       sync_mode   VARCHAR(20) DEFAULT 'fire_forget',
       timeout_ms  INT DEFAULT 15000,
       created_by  VARCHAR(100),
       created_at  BIGINT,
       INDEX idx_scope (scope, account_id)
     )`,
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
    "ALTER TABLE ai_tools ADD COLUMN n8n_integration_id VARCHAR(50)",
    "ALTER TABLE conversations     ADD COLUMN assigned_to JSON",
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
  ]
  for (const sql of migrations) {
    try { await pool.query(sql) } catch (e) { /* column exists or unsupported */ }
  }
  // Seed default token limits if NULL
  try {
    await pool.query(
      "UPDATE platform_settings SET change_agent_token_limits=? WHERE id=1 AND change_agent_token_limits IS NULL",
      [JSON.stringify({ basic: 50000, medium: 30000, complex: 15000 })]
    )
  } catch {}
  // Bucle de recordatorios de citas por WhatsApp
  try { require('./services/calendarReminders').start() } catch (e) { console.warn('[reminders] no iniciado:', e.message) }
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
