-- AVI Platform — MySQL Schema + Seed Data
-- Run: mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS avi_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE avi_platform;

-- ─── Core Tables ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS super_admins (
  id          VARCHAR(50)  PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  email       VARCHAR(100) UNIQUE NOT NULL,
  password    VARCHAR(100) NOT NULL,
  created_at  BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000)
);

CREATE TABLE IF NOT EXISTS accounts (
  id                         VARCHAR(50)  PRIMARY KEY,
  name                       VARCHAR(100) NOT NULL,
  email                      VARCHAR(100),
  plan                       ENUM('free','starter','pro','enterprise') DEFAULT 'free',
  status                     ENUM('active','suspended') DEFAULT 'active',
  openai_key                 TEXT,
  deepseek_key               TEXT,
  anthropic_key              TEXT,
  channel_limits_override    JSON,
  change_agent_limit_override INT DEFAULT NULL,
  change_agent_token_limits_override JSON DEFAULT NULL,
  created_at                 BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000)
);

CREATE TABLE IF NOT EXISTS roles (
  id          VARCHAR(50)  PRIMARY KEY,
  account_id  VARCHAR(50)  NOT NULL,
  name        VARCHAR(100) NOT NULL,
  is_system   TINYINT(1)   DEFAULT 0,
  permissions JSON,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS members (
  id           VARCHAR(50)  PRIMARY KEY,
  account_id   VARCHAR(50)  NOT NULL,
  name         VARCHAR(100) NOT NULL,
  email        VARCHAR(100) NOT NULL,
  password     VARCHAR(100) NOT NULL,
  avatar       VARCHAR(10),
  role_id      VARCHAR(50),
  agent_access JSON DEFAULT (JSON_ARRAY()),
  status       ENUM('active','inactive') DEFAULT 'active',
  created_at   BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agents (
  id              VARCHAR(50)  PRIMARY KEY,
  account_id      VARCHAR(50)  NOT NULL,
  name            VARCHAR(100) NOT NULL,
  status          ENUM('active','inactive') DEFAULT 'active',
  system_prompt   TEXT,
  model           VARCHAR(50)  DEFAULT 'gpt-4o-mini',
  welcome_message TEXT,
  prompts         JSON DEFAULT (JSON_ARRAY()),
  channels        JSON DEFAULT (JSON_ARRAY()),
  rag             JSON DEFAULT (JSON_OBJECT('enabled', FALSE, 'files', JSON_ARRAY())),
  ai_tool_ids     JSON DEFAULT (JSON_ARRAY()),
  created_at      BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversations (
  id             VARCHAR(80)  PRIMARY KEY,
  account_id     VARCHAR(50)  NOT NULL,
  agent_id       VARCHAR(50)  NOT NULL,
  channel_id     VARCHAR(50),
  channel_type   VARCHAR(20)  DEFAULT 'webchat',
  guest_name     VARCHAR(100),
  guest_id       VARCHAR(50),
  wa_from        VARCHAR(50),
  messenger_from VARCHAR(50),
  ig_from        VARCHAR(50),
  initials       VARCHAR(5),
  preview        VARCHAR(255) DEFAULT '',
  unread         TINYINT(1)   DEFAULT 0,
  ai_enabled     TINYINT(1)   DEFAULT 1,
  labels         JSON DEFAULT (JSON_ARRAY()),
  pipeline_cards JSON DEFAULT (JSON_ARRAY()),
  local_vars     JSON DEFAULT (JSON_OBJECT()),
  debug_log      JSON DEFAULT (JSON_ARRAY()),
  created_at     BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  updated_at     BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)   REFERENCES agents(id)   ON DELETE CASCADE,
  INDEX idx_agent   (account_id, agent_id),
  INDEX idx_updated (updated_at)
);

CREATE TABLE IF NOT EXISTS messages (
  id              VARCHAR(50) PRIMARY KEY,
  conversation_id VARCHAR(80) NOT NULL,
  sender          VARCHAR(20) NOT NULL,
  content         TEXT,
  metadata        JSON,
  ts              BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_conv (conversation_id, ts)
);

-- Media attachments stored base64-encoded; referenced from messages.metadata.mediaId
CREATE TABLE IF NOT EXISTS media (
  id              VARCHAR(50) PRIMARY KEY,
  account_id      VARCHAR(50) NOT NULL,
  conversation_id VARCHAR(80) NOT NULL,
  message_id      VARCHAR(50),
  kind            VARCHAR(20),     -- 'image' | 'video' | 'audio' | 'file'
  mime_type       VARCHAR(100),
  filename        VARCHAR(255),
  size_bytes      INT,
  data_base64     LONGTEXT,
  ts              BIGINT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  INDEX idx_media_conv (conversation_id, ts)
);

CREATE TABLE IF NOT EXISTS labels (
  id         VARCHAR(50)  PRIMARY KEY,
  account_id VARCHAR(50)  NOT NULL,
  name       VARCHAR(100) NOT NULL,
  color      VARCHAR(20),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pipelines (
  id         VARCHAR(50)  PRIMARY KEY,
  account_id VARCHAR(50)  NOT NULL,
  name       VARCHAR(100) NOT NULL,
  stages     JSON DEFAULT (JSON_ARRAY()),
  cards      JSON DEFAULT (JSON_ARRAY()),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS variables (
  id            VARCHAR(50)  PRIMARY KEY,
  account_id    VARCHAR(50)  NOT NULL,
  name          VARCHAR(100) NOT NULL,
  type          VARCHAR(20)  DEFAULT 'local',
  default_value TEXT,
  description   TEXT,
  is_system     TINYINT(1)   DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_tools (
  id             VARCHAR(50)  PRIMARY KEY,
  account_id     VARCHAR(50)  NOT NULL,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  collect_fields JSON DEFAULT (JSON_ARRAY()),
  flow_id        VARCHAR(50),
  created_at     BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS flows (
  id            VARCHAR(50)  PRIMARY KEY,
  account_id    VARCHAR(50)  NOT NULL,
  name          VARCHAR(100) NOT NULL,
  `trigger`     VARCHAR(50),
  start_node_id VARCHAR(50),
  nodes         JSON DEFAULT (JSON_ARRAY()),
  created_at    BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contacts (
  id         VARCHAR(50)  PRIMARY KEY,
  account_id VARCHAR(50)  NOT NULL,
  name       VARCHAR(100),
  email      VARCHAR(100),
  phone      VARCHAR(50),
  extra      JSON,
  created_at BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id         VARCHAR(50)  PRIMARY KEY,
  account_id VARCHAR(50)  NOT NULL,
  agent_id   VARCHAR(50)  NOT NULL,
  file_id    VARCHAR(50),
  file_name  VARCHAR(255),
  content    MEDIUMTEXT,
  embedding  LONGTEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  INDEX idx_rag (account_id, agent_id)
);

CREATE TABLE IF NOT EXISTS backups (
  id         VARCHAR(50)  PRIMARY KEY,
  account_id VARCHAR(50)  NOT NULL,
  agent_id   VARCHAR(50)  NOT NULL,
  label      VARCHAR(100),
  agent_name VARCHAR(100),
  size_bytes INT,
  data       LONGTEXT,
  -- 'master' = manual / scheduled. 'flash' = automatic before risky changes.
  type       VARCHAR(10) DEFAULT 'master',
  ts         BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  INDEX idx_backup (account_id, agent_id, ts),
  INDEX idx_backup_type (account_id, agent_id, type, ts)
);

CREATE TABLE IF NOT EXISTS backup_settings (
  account_id     VARCHAR(50) NOT NULL,
  agent_id       VARCHAR(50) NOT NULL,
  auto_backup    TINYINT(1)  DEFAULT 0,
  frequency      VARCHAR(20) DEFAULT 'daily',
  last_backup_at BIGINT,
  PRIMARY KEY (account_id, agent_id)
);

CREATE TABLE IF NOT EXISTS team_chat (
  id           VARCHAR(50)  PRIMARY KEY,
  account_id   VARCHAR(50)  NOT NULL,
  author_id    VARCHAR(50),
  author_name  VARCHAR(100),
  author_avatar VARCHAR(10),
  channel      VARCHAR(100) DEFAULT 'general',
  content      TEXT,
  ts           BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  INDEX idx_tc (account_id, channel, ts)
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id           VARCHAR(50)  PRIMARY KEY,
  account_id   VARCHAR(50),
  account_name VARCHAR(100),
  subject      VARCHAR(255),
  status       ENUM('open','in_progress','closed') DEFAULT 'open',
  assigned_to  JSON,
  created_at   BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  updated_at   BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000)
);

CREATE TABLE IF NOT EXISTS support_messages (
  id          VARCHAR(50) PRIMARY KEY,
  ticket_id   VARCHAR(50) NOT NULL,
  role        VARCHAR(20) NOT NULL,
  author_id   VARCHAR(50),
  author_name VARCHAR(100),
  content     TEXT,
  ts          BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invites (
  id         VARCHAR(50)  PRIMARY KEY,
  token      VARCHAR(100) UNIQUE NOT NULL,
  account_id VARCHAR(50)  NOT NULL,
  agent_id   VARCHAR(50),
  role_id    VARCHAR(50)  NOT NULL,
  created_by VARCHAR(100),
  created_at BIGINT DEFAULT (UNIX_TIMESTAMP() * 1000),
  used_at    BIGINT,
  used_by    VARCHAR(100),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id                              INT PRIMARY KEY DEFAULT 1,
  change_agent_model              VARCHAR(50) DEFAULT 'gpt-4o-mini',
  change_agent_default_limit      INT DEFAULT 20,
  change_agent_token_limits       JSON,
  channel_limits                  JSON,
  meta_app_id                     VARCHAR(64) DEFAULT '',
  prompt_generator_model          VARCHAR(50) DEFAULT 'gpt-4o',
  prompt_generator_structure      TEXT,
  prompt_generator_conditions     TEXT,
  prompt_generator_max_tokens     INT DEFAULT 8000,
  prompt_generator_temperature    DECIMAL(3,2) DEFAULT 0.55,
  prompt_generator_max_doc_chars  INT DEFAULT 200000,
  prompt_generator_allow_flows    TINYINT(1) DEFAULT 1,
  -- Default platform API keys (used as fallback when account has no own key)
  openai_key                      TEXT,
  deepseek_key                    TEXT,
  anthropic_key                   TEXT,
  media_max_size_mb               INT DEFAULT 30
);

CREATE TABLE IF NOT EXISTS prompt_change_history (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  account_id      VARCHAR(50) NOT NULL,
  agent_id        VARCHAR(50),
  prompt_id       VARCHAR(50),
  prompt_name     VARCHAR(100),
  user_id         VARCHAR(50),
  user_name       VARCHAR(100),
  instruction     TEXT,
  category        VARCHAR(20),
  was_edited_manually TINYINT(1) DEFAULT 0,
  old_content     MEDIUMTEXT,
  new_content     MEDIUMTEXT,
  input_tokens    INT DEFAULT 0,
  output_tokens   INT DEFAULT 0,
  total_tokens    INT DEFAULT 0,
  cost_usd        DECIMAL(12,6) DEFAULT 0,
  model           VARCHAR(80),
  provider        VARCHAR(20),
  backup_id       VARCHAR(50),
  ts              BIGINT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  INDEX idx_pch_acc (account_id, ts),
  INDEX idx_pch_agent (account_id, agent_id, ts)
);

CREATE TABLE IF NOT EXISTS change_agent_usage (
  account_id    VARCHAR(50) NOT NULL,
  month         VARCHAR(7)  NOT NULL,
  used          INT DEFAULT 0,
  basic_used    INT DEFAULT 0,
  medium_used   INT DEFAULT 0,
  complex_used  INT DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

CREATE TABLE IF NOT EXISTS counters (
  name  VARCHAR(50) PRIMARY KEY,
  value BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS token_usage (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  account_id        VARCHAR(50)  NOT NULL,
  agent_id          VARCHAR(50),
  conversation_id   VARCHAR(80),
  provider          VARCHAR(20),
  model             VARCHAR(80),
  prompt_tokens     INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  total_tokens      INT DEFAULT 0,
  cost_usd          DECIMAL(12,6) DEFAULT 0,
  source            VARCHAR(40),  -- 'chat' | 'change-agent' | 'prompt-generator' | 'rag-embed' | 'classify'
  ts                BIGINT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  INDEX idx_usage_acc_ts    (account_id, ts),
  INDEX idx_usage_acc_model (account_id, model),
  INDEX idx_usage_acc_agent (account_id, agent_id)
);

CREATE TABLE IF NOT EXISTS model_pricing (
  model         VARCHAR(80) PRIMARY KEY,
  provider      VARCHAR(20),
  input_per_1k  DECIMAL(10,6) DEFAULT 0,
  output_per_1k DECIMAL(10,6) DEFAULT 0,
  display_name  VARCHAR(100)
);

-- ─── Seed Data ────────────────────────────────────────────────────────────────

INSERT IGNORE INTO super_admins (id, name, email, password) VALUES
  ('sa_1', 'Super Admin', 'superadmin@avi.com', 'admin123');

INSERT IGNORE INTO platform_settings (id, change_agent_model, change_agent_default_limit, change_agent_token_limits, channel_limits, prompt_generator_model, prompt_generator_structure, prompt_generator_allow_flows) VALUES
  (1, 'gpt-4o-mini', 20,
   '{"basic":50000,"medium":30000,"complex":15000}',
   '{"free":{"webchat":1,"test":1,"whatsapp":0,"messenger":0,"instagram":0},"starter":{"webchat":3,"test":2,"whatsapp":1,"messenger":1,"instagram":1},"pro":{"webchat":10,"test":5,"whatsapp":3,"messenger":3,"instagram":3},"enterprise":{"webchat":-1,"test":-1,"whatsapp":-1,"messenger":-1,"instagram":-1}}',
   'gpt-4o',
   'Eres un asistente especializado.\n\n## Contexto\n[Contexto extraído del documento]\n\n## Personalidad y tono\n[Define la personalidad]\n\n## Instrucciones\n[Instrucciones específicas paso a paso]\n\n## Reglas\n- Responde siempre en español\n- Sé conciso y empático\n\n## Limitaciones\n[Qué NO debe hacer el agente]',
   1);

INSERT IGNORE INTO counters (name, value) VALUES ('guest_counter', 1000);

INSERT IGNORE INTO accounts (id, name, email, plan, status, openai_key, deepseek_key, channel_limits_override) VALUES
  ('acc_demo', 'Demo Company', 'demo@company.com', 'pro', 'active', '', '',
   '{"webchat":null,"test":null,"whatsapp":null,"messenger":null,"instagram":null}');

INSERT IGNORE INTO roles (id, account_id, name, is_system, permissions) VALUES
  ('role_owner', 'acc_demo', 'Owner', 1,
   '{"inbox":true,"agents":true,"channels":true,"crm":true,"pipeline":true,"config":true,"admins":true,"flows":true,"variables":true,"tools":true,"knowledge":true}'),
  ('role_agent', 'acc_demo', 'Agente', 0,
   '{"inbox":true,"agents":false,"channels":false,"crm":true,"pipeline":true,"config":false,"admins":false,"flows":false,"variables":false,"tools":false,"knowledge":false}');

INSERT IGNORE INTO members (id, account_id, name, email, password, avatar, role_id, agent_access, status) VALUES
  ('mem_1', 'acc_demo', 'Carlos López', 'owner@company.com', 'demo123', 'CL', 'role_owner', '[]', 'active');

INSERT IGNORE INTO agents (id, account_id, name, status, system_prompt, model, welcome_message, prompts, channels, rag, ai_tool_ids) VALUES
  ('ag_soporte', 'acc_demo', 'Soporte', 'active',
   'Eres un asistente de soporte amigable. Responde en español.',
   'gpt-4o-mini',
   '¡Hola! Soy el asistente de soporte. ¿En qué te puedo ayudar?',
   '[{"id":"pr_1","name":"Soporte General","content":"Eres un asistente de soporte amigable. Responde en español.","isActive":true,"provider":"openai","model":"gpt-4o-mini"},{"id":"pr_2","name":"Soporte Técnico","content":"Eres un experto técnico. Resuelve problemas paso a paso.","isActive":false,"provider":"openai","model":"gpt-4o-mini"}]',
   '[{"id":"lnk_main","type":"webchat","name":"Link principal","status":"active","config":{},"createdAt":0},{"id":"ch_test_1","type":"test","name":"Canal de pruebas","status":"active","config":{},"createdAt":0}]',
   '{"enabled":false,"files":[]}',
   '["tool_1"]');

INSERT IGNORE INTO labels (id, account_id, name, color) VALUES
  ('lbl_hot',      'acc_demo', 'Hot Lead',  '#ff5f5f'),
  ('lbl_client',   'acc_demo', 'Cliente',   '#22d98a'),
  ('lbl_prospect', 'acc_demo', 'Prospecto', '#f5a623');

INSERT IGNORE INTO pipelines (id, account_id, name, stages, cards) VALUES
  ('pipe_1', 'acc_demo', 'Embudo de Ventas',
   '[{"id":"st_1","name":"Nuevo Lead","color":"#4fa8ff","order":0},{"id":"st_2","name":"Contactado","color":"#f5a623","order":1},{"id":"st_3","name":"Cerrado","color":"#22d98a","order":2}]',
   '[]');

INSERT IGNORE INTO variables (id, account_id, name, type, default_value, description, is_system) VALUES
  ('var_nombre',  'acc_demo', 'nombre_completo', 'local',  '', 'Nombre completo del usuario', 1),
  ('var_empresa', 'acc_demo', 'empresa',         'global', 'AVI Demo', 'Nombre de la empresa', 0);

INSERT IGNORE INTO ai_tools (id, account_id, name, description, collect_fields, flow_id) VALUES
  ('tool_1', 'acc_demo', 'guardar_nombre',
   'Guarda el nombre completo del usuario cuando te lo proporcione.',
   '[{"label":"Nombre completo","variableId":"var_nombre","paramName":"nombre_completo"}]',
   NULL);

INSERT IGNORE INTO flows (id, account_id, name, `trigger`, start_node_id, nodes) VALUES
  ('flow_1', 'acc_demo', 'Bienvenida', 'conversation_start', 'n_1',
   '[{"id":"n_1","type":"message","x":120,"y":80,"data":{"text":"¡Bienvenido!"},"connections":["n_2"]},{"id":"n_2","type":"wait","x":380,"y":80,"data":{"seconds":2},"connections":[]}]');

-- ── Model pricing (USD per 1k tokens, ~Nov 2025) ─────────────────────────────
INSERT IGNORE INTO model_pricing (model, provider, input_per_1k, output_per_1k, display_name) VALUES
  ('gpt-4o-mini',              'openai',    0.000150, 0.000600, 'GPT-4o mini'),
  ('gpt-4o',                   'openai',    0.002500, 0.010000, 'GPT-4o'),
  ('gpt-4.1',                  'openai',    0.002000, 0.008000, 'GPT-4.1'),
  ('gpt-4.1-mini',             'openai',    0.000400, 0.001600, 'GPT-4.1 mini'),
  ('gpt-4.1-nano',             'openai',    0.000100, 0.000400, 'GPT-4.1 nano'),
  ('gpt-5',                    'openai',    0.001250, 0.010000, 'GPT-5'),
  ('gpt-5-mini',               'openai',    0.000250, 0.002000, 'GPT-5 mini'),
  ('gpt-5-nano',               'openai',    0.000050, 0.000400, 'GPT-5 nano'),
  ('o3',                       'openai',    0.002000, 0.008000, 'o3 (reasoning)'),
  ('o3-mini',                  'openai',    0.001100, 0.004400, 'o3-mini'),
  ('o4-mini',                  'openai',    0.001100, 0.004400, 'o4-mini'),
  ('o1',                       'openai',    0.015000, 0.060000, 'o1 (reasoning)'),
  ('o1-mini',                  'openai',    0.001100, 0.004400, 'o1-mini'),
  ('deepseek-chat',            'deepseek',  0.000270, 0.001100, 'DeepSeek V3.2'),
  ('deepseek-reasoner',        'deepseek',  0.000550, 0.002190, 'DeepSeek R1'),
  ('claude-opus-4-7',          'anthropic', 0.015000, 0.075000, 'Claude Opus 4.7'),
  ('claude-sonnet-4-6',        'anthropic', 0.003000, 0.015000, 'Claude Sonnet 4.6'),
  ('claude-haiku-4-5-20251001','anthropic', 0.001000, 0.005000, 'Claude Haiku 4.5'),
  ('text-embedding-3-small',   'openai',    0.000020, 0.000000, 'Embeddings (small)');
