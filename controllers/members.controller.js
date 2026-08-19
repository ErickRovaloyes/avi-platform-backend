'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')
const pw = require('../services/passwords')

const OWNER_PERMS = { inbox: true, agents: true, channels: true, crm: true, pipeline: true, config: true, admins: true, flows: true, variables: true, tools: true, knowledge: true }

// ── Members ───────────────────────────────────────────────────────────────────

/**
 * ¿Puede esta sesión gestionar el equipo de ESTA cuenta?
 *
 * Faltaba por completo. `authMiddleware` comprueba que HAY sesión, no de quién es, y no
 * existe ningún middleware que acote por cuenta: sin esta puerta, cualquier usuario con
 * sesión —de la cuenta que fuera— podía crear, editar o borrar miembros de OTRA cuenta
 * sabiendo sus identificadores. Apareció al añadir la baja voluntaria, tocando estas mismas
 * rutas.
 *
 * Devuelve el motivo del rechazo, o null si puede.
 */
function puedeGestionarEquipo(user, accId) {
  if (!user) return 'No hay sesión.'
  // El super admin —directo o en modo vista— administra cualquier cuenta: es su función.
  if (user.type === 'superadmin' || user.isImpersonating) return null
  if (user.type !== 'member') return 'No tienes acceso a esta cuenta.'
  if (String(user.accountId) !== String(accId)) return 'Esta cuenta no es la tuya.'
  const esDueno = String(user.roleId || '').startsWith('role_owner')
  if (!esDueno && !user.permissions?.admins) return 'No tienes permiso para gestionar el equipo.'
  return null
}

const createMember = async (req, res) => {
  const { accId } = req.params
  const noPuede = puedeGestionarEquipo(req.user, accId)
  if (noPuede) return res.status(403).json({ error: noPuede })
  const { id: gId, name, email, password, roleId, agentAccess = [], avatar } = req.body
  const cleanEmail = String(email || '').trim()
  // Solo si viene contraseña: el alta puede crearse sin ella (se copia de otra cuenta).
  if (password) { const v = pw.validate(password); if (!v.ok) return res.status(400).json({ error: v.error }) }
  try {
    // Idempotencia: una identidad (email) solo puede tener UNA membresía por cuenta.
    // Si ya existe, se actualiza (fusiona accesos a agentes) en vez de crear un duplicado.
    if (cleanEmail) {
      const [[existing]] = await pool.query('SELECT * FROM members WHERE account_id=? AND email=? LIMIT 1', [accId, cleanEmail])
      if (existing) {
        const mergedAccess = [...new Set([...(parseJ(existing.agent_access, [])), ...(Array.isArray(agentAccess) ? agentAccess : [])])]
        const sets = ['agent_access=?', 'status=?']; const vals = [JSON.stringify(mergedAccess), 'active']
        if (name)     { sets.push('name=?');    vals.push(name) }
        if (roleId)   { sets.push('role_id=?'); vals.push(roleId) }
        if (password) { sets.push('password=?'); vals.push(await pw.toStored(password)) }
        vals.push(existing.id, accId)
        await pool.query(`UPDATE members SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
        socket.emit(accId, 'account:updated', { accId })
        return res.json({ id: existing.id, existed: true })
      }
    }
    const id = gId || ('mem_' + uid())
    await pool.query(
      'INSERT INTO members (id,account_id,name,email,password,avatar,role_id,agent_access,status) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, accId, name, cleanEmail, await pw.toStored(password), avatar || (name || '').slice(0, 2).toUpperCase(), roleId, JSON.stringify(agentAccess), 'active']
    )
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) {
    console.error('[POST MEMBER]', err)
    res.status(500).json({ error: 'Error interno' })
  }
}

const updateMember = async (req, res) => {
  const { accId, memId } = req.params
  const noPuede = puedeGestionarEquipo(req.user, accId)
  if (noPuede) return res.status(403).json({ error: noPuede })
  const { name, email, roleId, agentAccess, status, password, avatar } = req.body
  try {
    if (password) { const v = pw.validate(password); if (!v.ok) return res.status(400).json({ error: v.error }) }
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');         vals.push(name) }
    if (email       !== undefined) { sets.push('email=?');        vals.push(email) }
    if (roleId      !== undefined) { sets.push('role_id=?');      vals.push(roleId) }
    if (agentAccess !== undefined) { sets.push('agent_access=?'); vals.push(JSON.stringify(agentAccess)) }
    if (status      !== undefined) { sets.push('status=?');       vals.push(status) }
    if (avatar      !== undefined) { sets.push('avatar=?');       vals.push(avatar) }
    // Only update the password when a non-empty value is provided
    if (password)                  { sets.push('password=?');     vals.push(await pw.toStored(password)) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(memId, accId)
    await pool.query(`UPDATE members SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    require('../services/visibilidadConvos').olvidarCache(accId)   // pudo cambiar de rol
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email ya en uso' })
    res.status(500).json({ error: 'Error interno' })
  }
}

// Quita a un miembro de UNA cuenta (nivel cuenta). El owner puede gestionar su equipo.
/**
 * Saca a un miembro de una cuenta y limpia lo que arrastra.
 *
 * El DELETE a secas dejaba dos cosas colgando, y una de ellas es una fuga: los tokens de push
 * del móvil. `services/push.js` manda a TODOS los tokens de la cuenta sin comprobar la
 * membresía, así que quien salía seguía recibiendo en su teléfono los avisos de mensajes de
 * clientes de una cuenta que ya no es suya.
 */
async function sacarMiembro(accId, memId) {
  await pool.query('DELETE FROM members WHERE id=? AND account_id=?', [memId, accId])
  // El teléfono deja de recibir avisos de esta cuenta.
  await pool.query('DELETE FROM push_tokens WHERE account_id=? AND member_id=?', [accId, memId]).catch(() => {})
  // Y las conversaciones que tuviera asignadas vuelven a quedar sin asignar, en vez de
  // apuntar a alguien que ya no existe.
  await pool.query(
    "UPDATE conversations SET assigned_to=NULL WHERE account_id=? AND JSON_EXTRACT(assigned_to,'$.id')=?",
    [accId, memId]).catch(() => {})
  socket.emit(accId, 'account:updated', { accId })
}

const deleteMember = async (req, res) => {
  const { accId, memId } = req.params
  const noPuede = puedeGestionarEquipo(req.user, accId)
  if (noPuede) return res.status(403).json({ error: noPuede })
  try {
    await sacarMiembro(accId, memId)
    res.json({ ok: true })
  } catch (err) { console.error('[deleteMember]', err); res.status(500).json({ error: 'Error interno' }) }
}

/**
 * Darse de baja UNO MISMO de la cuenta.
 *
 * Borra su usuario y su acceso; la cuenta, las conversaciones y el resto del equipo siguen
 * igual. Es reversible: quien administra la cuenta puede volver a invitarle.
 *
 * El DUEÑO no puede usar esta vía. Si se sacara a sí mismo, la cuenta quedaría sin nadie que
 * la administre —ni pueda invitar a nadie más— y solo se podría rescatar desde el Super
 * Panel. Para él existe el borrado de la cuenta entera, que sí está pensado para eso.
 */
const leaveAccount = async (req, res) => {
  const { accId } = req.params
  const u = req.user
  if (!u) return res.status(401).json({ error: 'No hay sesión.' })
  // Un super admin en modo vista entra con rol de dueño para poder trabajar: sin esta
  // comprobación se estaría dando de baja a sí mismo de la cuenta de un cliente.
  if (u.isImpersonating) return res.status(403).json({ error: 'Estás viendo esta cuenta como super admin; no puedes darte de baja de ella.' })
  if (u.type !== 'member') return res.status(403).json({ error: 'Solo un miembro de la cuenta puede darse de baja.' })
  if (String(u.accountId) !== String(accId)) return res.status(403).json({ error: 'Esta cuenta no es la tuya.' })
  if (u.roleId === 'role_owner') {
    return res.status(400).json({ error: 'Eres el dueño de la cuenta: si te dieras de baja, nadie podría administrarla. Usa «Borrar la cuenta» si quieres eliminarla, o pásale la propiedad a otra persona antes.' })
  }
  try {
    const [[m]] = await pool.query('SELECT id, email FROM members WHERE id=? AND account_id=?', [u.id, accId])
    if (!m) return res.status(404).json({ error: 'Tu usuario ya no está en esta cuenta.' })
    await sacarMiembro(accId, u.id)
    console.log(`[baja] ${m.email} se dio de baja de la cuenta ${accId}`)
    res.json({ ok: true })
  } catch (err) { console.error('[leaveAccount]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Un super admin se une a una cuenta como OWNER (crea/actualiza su membresía real).
// Funciona con sesión de super admin directa o detrás de una impersonación (usa saEmail).
const joinAsOwner = async (req, res) => {
  const { accId } = req.params
  const isSA  = req.user?.type === 'superadmin' || req.user?.isImpersonating
  const email = (req.user?.type === 'superadmin' ? req.user.email : req.user?.saEmail) || ''
  const name  = (req.user?.type === 'superadmin' ? req.user.name  : req.user?.saName)  || email
  if (!isSA || !email) return res.status(403).json({ error: 'Solo un super admin puede unirse como owner.' })
  try {
    const [[acc]] = await pool.query('SELECT id, name FROM accounts WHERE id=?', [accId])
    if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' })
    // Rol Owner de la cuenta (creado al crear la cuenta). Si no existe, se crea.
    let [[ownerRole]] = await pool.query("SELECT * FROM roles WHERE account_id=? AND name='Owner' ORDER BY is_system DESC LIMIT 1", [accId])
    if (!ownerRole) {
      const rid = 'role_owner_' + uid()
      await pool.query('INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,1,?)',
        [rid, accId, 'Owner', JSON.stringify(OWNER_PERMS)])
      ownerRole = { id: rid, permissions: JSON.stringify(OWNER_PERMS) }
    }
    // Contraseña real del super admin (para que la fila de miembro sea usable si se loguea).
    const [[sa]] = await pool.query('SELECT password FROM super_admins WHERE email=?', [email])
    const [[existing]] = await pool.query('SELECT * FROM members WHERE account_id=? AND email=? LIMIT 1', [accId, email])
    let memberId
    if (existing) {
      memberId = existing.id
      await pool.query('UPDATE members SET role_id=?, status=? WHERE id=? AND account_id=?', [ownerRole.id, 'active', existing.id, accId])
    } else {
      const [[sibling]] = await pool.query("SELECT password FROM members WHERE email=? AND password IS NOT NULL AND password<>'' LIMIT 1", [email])
      // Se copia el valor GUARDADO de otra fila del mismo usuario: ya es un hash, así que
      // toStored lo respeta tal cual (re-hashearlo dejaría a esa persona sin poder entrar).
      const password = await pw.toStored(sibling?.password || sa?.password || '')
      memberId = 'mem_' + uid()
      await pool.query('INSERT INTO members (id,account_id,name,email,password,avatar,role_id,agent_access,status) VALUES (?,?,?,?,?,?,?,?,?)',
        [memberId, accId, name, email, password, String(name || email).slice(0, 2).toUpperCase(), ownerRole.id, '[]', 'active'])
    }
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id: memberId, existed: !!existing })
  } catch (err) { console.error('[JOIN OWNER]', err); res.status(500).json({ error: 'Error interno' }) }
}

// Elimina un usuario por completo (todas sus membresías) — solo super admin.
// Útil para limpiar identidades duplicadas o dar de baja a alguien de toda la plataforma.
const deleteUserEverywhere = async (req, res) => {
  const isSA = req.user?.type === 'superadmin' || req.user?.isImpersonating
  if (!isSA) return res.status(403).json({ error: 'Solo un super admin puede eliminar usuarios.' })
  const email = String(req.body?.email || req.params?.email || '').trim()
  if (!email) return res.status(400).json({ error: 'Email requerido' })
  try {
    const [rows] = await pool.query('SELECT DISTINCT account_id FROM members WHERE email=?', [email])
    const [r] = await pool.query('DELETE FROM members WHERE email=?', [email])
    for (const { account_id } of rows) socket.emit(account_id, 'account:updated', { accId: account_id })
    res.json({ ok: true, removed: r.affectedRows || 0 })
  } catch (err) { console.error('[DELETE USER]', err); res.status(500).json({ error: 'Error interno' }) }
}

// ── Roles ─────────────────────────────────────────────────────────────────────

const createRole = async (req, res) => {
  const { accId } = req.params
  const { name, permissions = {} } = req.body
  const id = 'role_' + uid()
  try {
    await pool.query('INSERT INTO roles (id,account_id,name,is_system,permissions) VALUES (?,?,?,0,?)', [id, accId, name, JSON.stringify(permissions)])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateRole = async (req, res) => {
  const { accId, roleId } = req.params
  const { name, permissions } = req.body
  try {
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');        vals.push(name) }
    if (permissions !== undefined) { sets.push('permissions=?'); vals.push(JSON.stringify(permissions)) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(roleId, accId)
    await pool.query(`UPDATE roles SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    // El reparto por socket cachea quien esta restringido: sin esto, cambiar el permiso tarda
    // hasta medio minuto en notarse y parece que no funciono.
    require('../services/visibilidadConvos').olvidarCache(accId)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteRole = async (req, res) => {
  const { accId, roleId } = req.params
  try {
    await pool.query('DELETE FROM roles WHERE id=? AND account_id=? AND is_system=0', [roleId, accId])
    require('../services/visibilidadConvos').olvidarCache(accId)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Teams (equipos / grupos de miembros) ───────────────────────────────────────

const createTeam = async (req, res) => {
  const { accId } = req.params
  const { name, color = '#7c6fff', memberIds = [] } = req.body
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Nombre requerido' })
  const id = 'team_' + uid()
  try {
    await pool.query('INSERT INTO teams (id,account_id,name,color,member_ids,created_at) VALUES (?,?,?,?,?,?)',
      [id, accId, String(name).trim(), color, JSON.stringify(Array.isArray(memberIds) ? memberIds : []), Date.now()])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { console.error('[POST TEAM]', err); res.status(500).json({ error: 'Error interno' }) }
}

const updateTeam = async (req, res) => {
  const { accId, teamId } = req.params
  const { name, color, memberIds } = req.body
  try {
    const sets = []; const vals = []
    if (name      !== undefined) { sets.push('name=?');       vals.push(String(name).trim()) }
    if (color     !== undefined) { sets.push('color=?');      vals.push(color) }
    if (memberIds !== undefined) { sets.push('member_ids=?'); vals.push(JSON.stringify(Array.isArray(memberIds) ? memberIds : [])) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(teamId, accId)
    await pool.query(`UPDATE teams SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteTeam = async (req, res) => {
  const { accId, teamId } = req.params
  try {
    await pool.query('DELETE FROM teams WHERE id=? AND account_id=?', [teamId, accId])
    // Desasignar el equipo de las conversaciones que lo tuvieran.
    try { await pool.query('UPDATE conversations SET team_id=NULL WHERE account_id=? AND team_id=?', [accId, teamId]) } catch {}
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

// ── Labels ────────────────────────────────────────────────────────────────────

// `description` explica cuándo aplicar la etiqueta y `ai_enabled` si el asistente puede
// usarla: los lee la herramienta IA de etiquetado, así que conviene que sean concretas.
const createLabel = async (req, res) => {
  const { accId } = req.params
  const { name, color, description, aiEnabled } = req.body
  const id = 'lbl_' + uid()
  try {
    await pool.query('INSERT INTO labels (id,account_id,name,color,description,ai_enabled) VALUES (?,?,?,?,?,?)',
      [id, accId, name, color, description || null, aiEnabled === false ? 0 : 1])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updateLabel = async (req, res) => {
  const { accId, lblId } = req.params
  const { name, color, description, aiEnabled } = req.body
  try {
    const sets = []; const vals = []
    if (name        !== undefined) { sets.push('name=?');        vals.push(name) }
    if (color       !== undefined) { sets.push('color=?');       vals.push(color) }
    if (description !== undefined) { sets.push('description=?'); vals.push(description || null) }
    if (aiEnabled   !== undefined) { sets.push('ai_enabled=?');  vals.push(aiEnabled ? 1 : 0) }
    if (!sets.length) return res.json({ ok: true })
    await pool.query(`UPDATE labels SET ${sets.join(',')} WHERE id=? AND account_id=?`, [...vals, lblId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const deleteLabel = async (req, res) => {
  const { accId, lblId } = req.params
  try {
    await pool.query('DELETE FROM labels WHERE id=? AND account_id=?', [lblId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = {
  createMember, updateMember, deleteMember, leaveAccount, deleteUserEverywhere, joinAsOwner,
  createRole, updateRole, deleteRole,
  createTeam, updateTeam, deleteTeam,
  createLabel, updateLabel, deleteLabel,
}
