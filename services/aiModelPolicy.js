'use strict'
/**
 * Política de modelo según Google
 * ───────────────────────────────
 * Las herramientas de Google (Sheets y Calendario) NO funcionan con DeepSeek, así que el
 * modelo del asistente lo decide el estado de la conexión de Google, no una elección suelta:
 *
 *     Google conectado  →  GPT-5 mini (OpenAI)
 *     sin Google        →  DeepSeek V4 Flash      ← el valor por defecto de la plataforma
 *
 * Antes esto era un BLOQUEO: con Google conectado y un prompt DeepSeek, el nodo IA se
 * negaba a responder y había que ir a cambiar el modelo a mano. El asistente se quedaba
 * mudo por una incompatibilidad que el sistema ya conocía. Ahora se corrige solo.
 *
 * Se aplica en dos sitios a propósito:
 *   · al conectar/desconectar Google (controllers/google.controller.js) → escribe en la BD,
 *     de forma que la UI de Prompts muestre el modelo que se va a usar de verdad;
 *   · al ejecutar el nodo IA (flow/nodes/ai.js) → red de seguridad en tiempo de lectura.
 *     Cubre las cuentas que ya tenían Google conectado antes de que esto existiera y
 *     cualquier caso en que la escritura de arriba se hubiera perdido.
 *
 * El objetivo de la segunda capa es que el modelo efectivo NUNCA dependa de que una
 * escritura anterior saliera bien.
 */
const pool = require('../db')
const socket = require('./socket')

// Ids tal cual aparecen en el catálogo de modelos (services/aiClient.js). Si allí cambian,
// aquí también: son los que se guardan en el prompt y se mandan a la API.
const GOOGLE_TARGET  = { provider: 'openai',   model: 'gpt-5-mini',        label: 'GPT-5 mini' }
const DEFAULT_TARGET = { provider: 'deepseek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }

function targetFor(googleConnected) {
  return googleConnected ? GOOGLE_TARGET : DEFAULT_TARGET
}

/**
 * Aplica la política al prompt ACTIVO de cada agente de la cuenta.
 *
 * @param {string}  accId
 * @param {boolean} googleConnected  estado YA resuelto por quien llama (evita depender de
 *                                   la caché de conexiones justo después de escribirla).
 * @returns {{changed:number, agents:number, provider:string, model:string, label:string}}
 */
async function applyToAccount(accId, googleConnected) {
  const target = targetFor(googleConnected)
  if (!accId) return { changed: 0, agents: 0, ...target }

  const [agents] = await pool.query('SELECT id, prompts FROM agents WHERE account_id=?', [accId])
  let changed = 0

  for (const ag of agents) {
    let prompts
    try { prompts = JSON.parse(ag.prompts || '[]') } catch { continue }
    if (!Array.isArray(prompts) || !prompts.length) continue

    // El prompt activo; si ninguno lo está, el primero. Es la misma regla de desempate que
    // ya usan recontact.js, orderNotify.js y calendarNotify.js para elegir "el" prompt.
    const idx = prompts.findIndex(p => p && p.isActive)
    const i = idx >= 0 ? idx : 0
    const cur = prompts[i] || {}
    if (cur.provider === target.provider && cur.model === target.model) continue

    prompts[i] = {
      ...cur,
      provider: target.provider,
      model: target.model,
      // Rastro de que el cambio fue automático y por qué. La UI lo lee para explicarlo en
      // vez de que el modelo parezca haber cambiado solo.
      autoModel: googleConnected ? 'google' : 'default',
      autoModelAt: Date.now(),
    }
    // agents.model refleja el modelo del prompt activo (así lo deja accountProvision).
    await pool.query('UPDATE agents SET prompts=?, model=? WHERE id=?',
      [JSON.stringify(prompts), target.model, ag.id])
    changed++
  }

  if (changed) {
    // Refresca la pestaña abierta: si no, el asesor seguiría viendo el modelo anterior.
    try { socket.emit(accId, 'account:updated', { accId }) } catch {}
    console.log(`[modelPolicy] ${accId}: ${changed} prompt(s) → ${target.model} (google=${!!googleConnected})`)
  }
  return { changed, agents: agents.length, ...target }
}

module.exports = { GOOGLE_TARGET, DEFAULT_TARGET, targetFor, applyToAccount }
