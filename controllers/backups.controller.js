'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

// Cap of backups kept per (account, agent) per type.
// Master = manual / scheduled. Flash = auto-snapshot before risky actions.
const MAX_MASTER = 10
const MAX_FLASH  = 100

const listBackups = async (req, res) => {
  const { accId, agId } = req.params
  const { type } = req.query // optional 'master' | 'flash'; else all
  try {
    let sql = 'SELECT id,label,agent_name,size_bytes,type,ts FROM backups WHERE account_id=? AND agent_id=?'
    const params = [accId, agId]
    if (type === 'master' || type === 'flash') { sql += ' AND type=?'; params.push(type) }
    sql += ' ORDER BY ts DESC LIMIT 200'
    const [rows] = await pool.query(sql, params)
    res.json(rows.map(r => ({
      id: r.id, label: r.label, agentName: r.agent_name,
      sizeBytes: r.size_bytes, type: r.type || 'master', ts: r.ts,
    })))
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// Build a snapshot of the agent + account-scoped settings + conversations.
// Master backups include the full chat history. Flash backups skip messages
// (they're created automatically before risky changes and we want them lean).
async function buildSnapshot(accId, agId, { includeMessages = true } = {}) {
  const [[ag]]    = await pool.query('SELECT * FROM agents WHERE id=? AND account_id=?', [agId, accId])
  if (!ag) return null
  const [labels]    = await pool.query('SELECT * FROM labels    WHERE account_id=?', [accId])
  const [variables] = await pool.query('SELECT * FROM variables WHERE account_id=?', [accId])
  const [aiTools]   = await pool.query('SELECT * FROM ai_tools  WHERE account_id=?', [accId])
  const [flows]     = await pool.query('SELECT * FROM flows     WHERE account_id=?', [accId])

  let conversations = []
  if (includeMessages) {
    const [convs] = await pool.query('SELECT * FROM conversations WHERE account_id=? AND agent_id=?', [accId, agId])
    const convIds = convs.map(c => c.id)
    let msgsByConv = {}
    if (convIds.length) {
      const [msgs] = await pool.query('SELECT * FROM messages WHERE conversation_id IN (?) ORDER BY ts ASC', [convIds])
      for (const m of msgs) {
        if (!msgsByConv[m.conversation_id]) msgsByConv[m.conversation_id] = []
        msgsByConv[m.conversation_id].push({
          id: m.id, sender: m.sender, content: m.content, ts: m.ts,
          ...parseJ(m.metadata, {}),
        })
      }
    }
    conversations = convs.map(c => ({
      id: c.id, channel: c.channel_type, channelId: c.channel_id,
      guestName: c.guest_name, guestId: c.guest_id, initials: c.initials,
      waFrom: c.wa_from, messengerFrom: c.messenger_from, igFrom: c.ig_from,
      preview: c.preview, aiEnabled: !!c.ai_enabled,
      labels:        parseJ(c.labels, []),
      pipelineCards: parseJ(c.pipeline_cards, []),
      localVars:     parseJ(c.local_vars, {}),
      assignedTo:    parseJ(c.assigned_to, null),
      messages:      msgsByConv[c.id] || [],
      createdAt: c.created_at, updatedAt: c.updated_at,
    }))
  }

  return {
    agent: {
      id: ag.id, name: ag.name, status: ag.status,
      systemPrompt: ag.system_prompt, model: ag.model, welcomeMessage: ag.welcome_message,
      prompts:  parseJ(ag.prompts,  []),
      channels: parseJ(ag.channels, []),
      rag:      parseJ(ag.rag,      { enabled: false, files: [] }),
      aiToolIds: parseJ(ag.ai_tool_ids, []),
    },
    accountSettings: {
      labels:    labels.map(l => ({ id: l.id, name: l.name, color: l.color })),
      variables: variables.map(v => ({ id: v.id, name: v.name, type: v.type, defaultValue: v.default_value, description: v.description, isSystem: !!v.is_system })),
      aiTools:   aiTools.map(t => ({ id: t.id, name: t.name, description: t.description, collectFields: parseJ(t.collect_fields, []), flowId: t.flow_id })),
      flows:     flows.map(f => ({ id: f.id, name: f.name, trigger: f.trigger, startNodeId: f.start_node_id, nodes: parseJ(f.nodes, []) })),
    },
    conversations,
    createdAt: Date.now(),
    includesMessages: includeMessages,
  }
}

// Internal helper — also used from other controllers (e.g. on prompt change)
async function createBackupInternal({ accId, agId, label, type = 'master' }) {
  // Master backups include the full chat history; flash backups stay lean.
  const snapshot = await buildSnapshot(accId, agId, { includeMessages: type !== 'flash' })
  if (!snapshot) throw new Error('Agente no encontrado')

  const id  = 'bk_' + uid()
  const ts  = Date.now()
  const str = JSON.stringify(snapshot)
  const sz  = Buffer.byteLength(str, 'utf8')
  const agentName = snapshot.agent?.name || ''
  const finalLabel = (label && label.trim()) || `${type === 'flash' ? '⚡ Flash' : 'Backup'} ${new Date(ts).toLocaleString('es')}`
  const finalType = type === 'flash' ? 'flash' : 'master'

  await pool.query(
    'INSERT INTO backups (id,account_id,agent_id,label,agent_name,size_bytes,data,type,ts) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, accId, agId, finalLabel, agentName, sz, str, finalType, ts]
  )

  // Trim older backups of the same type
  const cap = finalType === 'flash' ? MAX_FLASH : MAX_MASTER
  const [old] = await pool.query(
    'SELECT id FROM backups WHERE account_id=? AND agent_id=? AND type=? ORDER BY ts DESC LIMIT 5000 OFFSET ?',
    [accId, agId, finalType, cap]
  )
  if (old.length) await pool.query('DELETE FROM backups WHERE id IN (?)', [old.map(o => o.id)])

  return { id, ts, sizeBytes: sz, agentName, label: finalLabel, type: finalType }
}

const createBackup = async (req, res) => {
  const { accId, agId } = req.params
  const { label, type = 'master' } = req.body || {}
  try {
    const result = await createBackupInternal({ accId, agId, label, type })
    res.json(result)
  } catch (err) {
    console.error('[POST BACKUP]', err)
    res.status(500).json({ error: err.message || 'Error interno' })
  }
}

const deleteBackup = async (req, res) => {
  const { accId, agId, bkId } = req.params
  try {
    await pool.query('DELETE FROM backups WHERE id=? AND account_id=? AND agent_id=?', [bkId, accId, agId])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const restoreBackup = async (req, res) => {
  const { accId, agId, bkId } = req.params
  try {
    const [[row]] = await pool.query('SELECT data FROM backups WHERE id=? AND account_id=? AND agent_id=?', [bkId, accId, agId])
    if (!row) return res.status(404).json({ error: 'Backup no encontrado' })
    const { agent, accountSettings: s } = parseJ(row.data, {})
    if (agent) {
      await pool.query(
        'UPDATE agents SET name=?,system_prompt=?,model=?,welcome_message=?,prompts=?,channels=?,rag=?,ai_tool_ids=? WHERE id=? AND account_id=?',
        [agent.name, agent.systemPrompt, agent.model, agent.welcomeMessage,
         JSON.stringify(agent.prompts || []), JSON.stringify(agent.channels || []),
         JSON.stringify(agent.rag || {}), JSON.stringify(agent.aiToolIds || []), agId, accId]
      )
    }
    if (s?.labels)    await pool.query('DELETE FROM labels WHERE account_id=?', [accId]).then(() => s.labels.length && pool.query('INSERT INTO labels (id,account_id,name,color) VALUES ?', [s.labels.map(l => [l.id, accId, l.name, l.color])]))
    if (s?.variables) await pool.query('DELETE FROM variables WHERE account_id=?', [accId]).then(() => s.variables.length && pool.query('INSERT INTO variables (id,account_id,name,type,default_value,description,is_system) VALUES ?', [s.variables.map(v => [v.id, accId, v.name, v.type, v.defaultValue, v.description, v.isSystem ? 1 : 0])]))
    if (s?.aiTools)   await pool.query('DELETE FROM ai_tools WHERE account_id=?', [accId]).then(() => s.aiTools.length && pool.query('INSERT INTO ai_tools (id,account_id,name,description,collect_fields,flow_id) VALUES ?', [s.aiTools.map(t => [t.id, accId, t.name, t.description, JSON.stringify(t.collectFields || []), t.flowId])]))
    if (s?.flows)     await pool.query('DELETE FROM flows WHERE account_id=?', [accId]).then(() => s.flows.length && pool.query('INSERT INTO flows (id,account_id,name,`trigger`,start_node_id,nodes) VALUES ?', [s.flows.map(f => [f.id, accId, f.name, f.trigger, f.startNodeId, JSON.stringify(f.nodes || [])])]))
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[RESTORE]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const getBackupSettings = async (req, res) => {
  const { accId, agId } = req.params
  try {
    const [[r]] = await pool.query('SELECT * FROM backup_settings WHERE account_id=? AND agent_id=?', [accId, agId])
    res.json(r ? { autoBackup: !!r.auto_backup, frequency: r.frequency, lastBackupAt: r.last_backup_at } : {})
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const putBackupSettings = async (req, res) => {
  const { accId, agId } = req.params
  const { autoBackup, frequency, lastBackupAt } = req.body
  try {
    await pool.query(
      'INSERT INTO backup_settings (account_id,agent_id,auto_backup,frequency,last_backup_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE auto_backup=VALUES(auto_backup),frequency=VALUES(frequency),last_backup_at=VALUES(last_backup_at)',
      [accId, agId, autoBackup ? 1 : 0, frequency || 'daily', lastBackupAt || null]
    )
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { listBackups, createBackup, createBackupInternal, deleteBackup, restoreBackup, getBackupSettings, putBackupSettings }
