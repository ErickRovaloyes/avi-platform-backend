'use strict'
/**
 * Entorno de pruebas: una cuenta ESPEJO de la real.
 *
 * No es un canal de pruebas ni una marca en cada cosa: es una cuenta hermana de verdad, con su
 * propia configuración y sus propios chats. Lo que se toca ahí no puede llegar a la cuenta real
 * porque, sencillamente, son cuentas distintas — no hay ninguna consulta que las mezcle.
 *
 * El acceso sale gratis: `allAccountIds` se calcula desde las filas de `members` por correo
 * (auth.controller), así que copiando a los miembros la cuenta espejo aparece sola en el
 * selector de cuentas y `switchAccount` funciona sin tocar nada del login.
 *
 * Lo que se copia: agentes, prompts, flujos, herramientas, etiquetas, pipelines (sin tarjetas),
 * variables y agendas. Lo que NO: conversaciones, contactos y pedidos — el entorno de pruebas
 * empieza vacío de gente real, que es justamente la gracia.
 *
 * Y los canales entran DESCONECTADOS y sin credenciales. Es la regla que hace creíble el
 * aislamiento: un entorno de pruebas no puede escribirle por WhatsApp a un cliente de verdad.
 */
const pool = require('../db')
const { uid, parseJ } = require('../utils')

const nuevoId = pre => `${pre}_${uid()}`

/**
 * Deja los canales de un agente inertes: sin credenciales y marcados como desconectados.
 * Se conserva el tipo y el nombre para que la configuración se reconozca, pero no puede salir
 * ni un mensaje.
 */
function desconectarCanales(channelsJson) {
  const canales = parseJ(channelsJson, [])
  if (!Array.isArray(canales)) return '[]'
  return JSON.stringify(canales.map(c => ({
    id: c.id, type: c.type, name: c.name,
    status: 'disconnected',
    config: {},              // fuera tokens, phoneNumberId, pageId… todo
    sandboxNote: 'Canal desconectado en el entorno de pruebas',
  })))
}

/** ¿Esta cuenta es un entorno de pruebas, y de quién? */
async function infoDe(accId) {
  const [[a]] = await pool.query('SELECT id, name, sandbox_of FROM accounts WHERE id=?', [accId])
  if (!a) return null
  if (a.sandbox_of) return { esSandbox: true, padreId: a.sandbox_of, id: a.id, name: a.name }
  const [[hijo]] = await pool.query('SELECT id, name FROM accounts WHERE sandbox_of=?', [accId])
  return { esSandbox: false, sandboxId: hijo?.id || null, sandboxName: hijo?.name || null, id: a.id, name: a.name }
}

/**
 * Vuelca la configuración de la cuenta real en la de pruebas.
 *
 * Se borra antes lo que hubiera: rehacer la copia tiene que dejar el entorno EXACTAMENTE como la
 * cuenta real, no fusionar dos estados. Las conversaciones y contactos del entorno de pruebas se
 * respetan salvo que se pida limpiarlos.
 */
async function volcarConfig(padreId, sandboxId, { limpiarChats = false } = {}) {
  // Fuera la configuración vieja del entorno (no los chats, salvo que se pida).
  for (const t of ['agents', 'flows', 'labels', 'pipelines', 'variables', 'ai_tools']) {
    await pool.query(`DELETE FROM ${t} WHERE account_id=?`, [sandboxId]).catch(() => {})
  }
  if (limpiarChats) {
    await pool.query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE account_id=?)', [sandboxId]).catch(() => {})
    for (const t of ['conversations', 'contacts']) {
      await pool.query(`DELETE FROM ${t} WHERE account_id=?`, [sandboxId]).catch(() => {})
    }
  }

  // Los ids de flujo se remapean: los prompts y las herramientas los referencian, y si se
  // copiaran tal cual el entorno de pruebas apuntaría a los flujos de la cuenta REAL.
  const mapaFlujos = new Map()
  const [flujos] = await pool.query('SELECT * FROM flows WHERE account_id=?', [padreId])
  for (const f of flujos) mapaFlujos.set(f.id, nuevoId('flow'))
  for (const f of flujos) {
    let nodos = f.nodes
    // Un flujo puede saltar a otro: esas referencias también se remapean.
    if (typeof nodos === 'string') {
      for (const [viejo, nuevo] of mapaFlujos) nodos = nodos.split(`"${viejo}"`).join(`"${nuevo}"`)
    }
    await pool.query(
      'INSERT INTO flows (id,account_id,name,start_node_id,nodes,created_at) VALUES (?,?,?,?,?,?)',
      [mapaFlujos.get(f.id), sandboxId, f.name, f.start_node_id, nodos, Date.now()]
    )
  }

  const [herramientas] = await pool.query('SELECT * FROM ai_tools WHERE account_id=?', [padreId])
  const mapaTools = new Map()
  for (const t of herramientas) {
    const id = nuevoId('tool')
    mapaTools.set(t.id, id)
    await pool.query(
      'INSERT INTO ai_tools (id,account_id,name,description,collect_fields,flow_id,action_type,catalog_id,catalog_version) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, sandboxId, t.name, t.description, t.collect_fields, mapaFlujos.get(t.flow_id) || null,
       t.action_type || 'variable', t.catalog_id || null, t.catalog_version || null]
    ).catch(() => {})
  }

  const [agentes] = await pool.query('SELECT * FROM agents WHERE account_id=?', [padreId])
  for (const g of agentes) {
    // Los prompts referencian herramientas y ficheros; se remapean los ids de herramienta.
    let prompts = g.prompts
    if (typeof prompts === 'string') {
      for (const [viejo, nuevo] of mapaTools) prompts = prompts.split(`"${viejo}"`).join(`"${nuevo}"`)
    }
    await pool.query(
      'INSERT INTO agents (id,account_id,name,status,system_prompt,model,welcome_message,prompts,channels,rag,ai_tool_ids,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [nuevoId('ag'), sandboxId, g.name, g.status, g.system_prompt, g.model, g.welcome_message,
       prompts, desconectarCanales(g.channels), g.rag,
       JSON.stringify((parseJ(g.ai_tool_ids, []) || []).map(x => mapaTools.get(x) || x)),
       Date.now()]
    )
  }

  for (const [tabla, cols] of [
    ['labels',    ['id', 'account_id', 'name', 'color']],
    ['variables', ['id', 'account_id', 'name', 'type', 'default_value', 'description', 'is_system']],
  ]) {
    const [filas] = await pool.query(`SELECT * FROM ${tabla} WHERE account_id=?`, [padreId])
    for (const f of filas) {
      const vals = cols.map(c => (c === 'id' ? nuevoId(tabla.slice(0, 3)) : c === 'account_id' ? sandboxId : f[c]))
      await pool.query(`INSERT INTO ${tabla} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals).catch(() => {})
    }
  }

  // Pipelines con sus etapas pero SIN tarjetas: las tarjetas son negocio real.
  const [pipes] = await pool.query('SELECT * FROM pipelines WHERE account_id=?', [padreId])
  for (const p of pipes) {
    await pool.query('INSERT INTO pipelines (id,account_id,name,stages,cards) VALUES (?,?,?,?,?)',
      [nuevoId('pipe'), sandboxId, p.name, p.stages, '[]']).catch(() => {})
  }

  // La configuración de la cuenta que SÍ viaja (prompts del negocio, recontactos, tienda…).
  // Las claves de IA se copian para que el entorno funcione; los canales ya van desconectados.
  await pool.query(
    `UPDATE accounts SET openai_key=(SELECT openai_key FROM (SELECT openai_key FROM accounts WHERE id=?) x),
            deepseek_key=(SELECT deepseek_key FROM (SELECT deepseek_key FROM accounts WHERE id=?) y),
            recontact=(SELECT recontact FROM (SELECT recontact FROM accounts WHERE id=?) z)
      WHERE id=?`,
    [padreId, padreId, padreId, sandboxId]
  ).catch(e => console.warn('[sandbox] config de cuenta:', e.message))
}

/** Copia a los miembros de la cuenta real para que entren al entorno con su mismo correo. */
async function copiarMiembros(padreId, sandboxId) {
  await pool.query('DELETE FROM members WHERE account_id=?', [sandboxId]).catch(() => {})
  const [ms] = await pool.query('SELECT * FROM members WHERE account_id=?', [padreId])
  for (const m of ms) {
    await pool.query(
      'INSERT INTO members (id,account_id,name,email,password,avatar,role_id,agent_access,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [nuevoId('mem'), sandboxId, m.name, m.email, m.password, m.avatar, m.role_id, '[]', m.status, Date.now()]
    ).catch(e => console.warn('[sandbox] miembro:', e.message))
  }
}

/**
 * Crea el entorno de pruebas de una cuenta, o lo rehace si ya existe.
 * Devuelve `{ id, name, creado }`.
 */
async function crearOrehacer(padreId, { limpiarChats = false } = {}) {
  const [[padre]] = await pool.query('SELECT * FROM accounts WHERE id=?', [padreId])
  if (!padre) throw new Error('La cuenta no existe.')
  if (padre.sandbox_of) throw new Error('Esta YA es una cuenta de pruebas; no se anidan.')

  let [[sandbox]] = await pool.query('SELECT * FROM accounts WHERE sandbox_of=?', [padreId])
  let creado = false
  if (!sandbox) {
    const id = nuevoId('acc')
    await pool.query(
      'INSERT INTO accounts (id,name,email,plan,status,sandbox_of,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, `${padre.name} · Pruebas`, padre.email, padre.plan, 'active', padreId, Date.now()]
    )
    sandbox = { id }
    creado = true
  }
  await volcarConfig(padreId, sandbox.id, { limpiarChats })
  await copiarMiembros(padreId, sandbox.id)
  return { id: sandbox.id, name: `${padre.name} · Pruebas`, creado }
}

/** Elimina el entorno de pruebas y todo lo que contiene. */
async function eliminar(padreId) {
  const [[s]] = await pool.query('SELECT id FROM accounts WHERE sandbox_of=?', [padreId])
  if (!s) return { ok: true, nada: true }
  await pool.query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE account_id=?)', [s.id]).catch(() => {})
  // El resto cae por la clave foránea con ON DELETE CASCADE.
  await pool.query('DELETE FROM accounts WHERE id=?', [s.id])
  return { ok: true, id: s.id }
}

module.exports = { infoDe, crearOrehacer, eliminar, desconectarCanales }
