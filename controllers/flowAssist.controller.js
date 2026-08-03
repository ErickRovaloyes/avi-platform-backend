'use strict'
/**
 * Ayudas de ejecución de flujos que el motor del NAVEGADOR (webchat / prueba) no puede
 * resolver por su cuenta: necesitan la base de datos o una API key del servidor.
 *
 * Público como el resto de proxies del motor (p. ej. /data-tables/tool): el widget del
 * webchat no está autenticado. Solo devuelve el nombre del asesor que toca y un texto ya
 * redactado — nunca datos sensibles de la cuenta.
 */
const pool = require('../db')
const assignment = require('../services/assignment')

// Miembros activos de la cuenta (id y nombre; nada más sale de aquí).
async function membersOf(accId) {
  try {
    const [rows] = await pool.query("SELECT id, name, status FROM members WHERE account_id=?", [accId])
    return rows
  } catch { return [] }
}

// POST /accounts/:accId/flow/transfer-resolve
// body: { scope, cfg:{modo,asignar_a,equipoId,miembros,reparto}, convId, agId, draft, extra }
// → { assignees:[{id,name}], all, message }
const transferResolve = async (req, res) => {
  const { accId } = req.params
  const b = req.body || {}
  try {
    const members = await membersOf(accId)
    const { assignees, all } = await assignment.pickAssignees(
      accId, b.cfg || {}, members, String(b.scope || 'transfer:default').slice(0, 120)
    )
    let message = null
    if (b.draft && b.convId) {
      message = await draftMessage(accId, {
        convId: b.convId, assignee: assignees[0] || null, extra: b.extra,
      })
    }
    res.json({ assignees, all, message })
  } catch (err) {
    console.error('[transferResolve]', err)
    res.json({ assignees: [], all: false, message: null })   // nunca romper el flujo
  }
}

// Redacta el mensaje de transferencia con IA a partir del historial real de la conversación.
async function draftMessage(accId, { convId, assignee, extra } = {}) {
  try {
    const { chat, getApiKey, detectProvider } = require('../services/aiClient')
    const [[acc]] = await pool.query(
      'SELECT name, openai_key, deepseek_key, anthropic_key FROM accounts WHERE id=?', [accId])
    if (!acc) return null
    // El modelo por defecto lo gobierna la plataforma (las cuentas no tienen override).
    const [[plat]] = await pool.query(
      'SELECT openai_key, deepseek_key, anthropic_key, default_prompt_model, default_prompt_provider FROM platform_settings WHERE id=1')
    const model = plat?.default_prompt_model || 'gpt-4o-mini'
    const provider = plat?.default_prompt_provider || detectProvider(model)
    const keyBag = {
      openaiKey: acc.openai_key || plat?.openai_key || '',
      deepseekKey: acc.deepseek_key || plat?.deepseek_key || '',
      anthropicKey: acc.anthropic_key || plat?.anthropic_key || '',
    }
    const apiKey = getApiKey(keyBag, provider)
    if (!apiKey) return null

    const [rows] = await pool.query(
      'SELECT sender, content FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT 10', [convId])
    const history = rows.reverse().filter(r => r.content)
      .map(r => ({ role: r.sender === 'user' ? 'user' : 'assistant', content: String(r.content).slice(0, 600) }))
    if (!history.length) return null

    const sys = `Eres el asistente virtual de ${acc.name || 'la empresa'}. Vas a TRANSFERIR esta conversación a ` +
      `${assignee?.name ? `un asesor humano llamado ${assignee.name}` : 'un asesor humano'}. ` +
      `Redacta UN SOLO mensaje breve (máximo 2 frases) para el cliente, en su mismo idioma y en el tono de la conversación, que: ` +
      `(1) reconozca de forma concreta lo que el cliente venía pidiendo o el problema que planteó, y ` +
      `(2) le avise de que un asesor humano continúa la atención. ` +
      `No inventes datos, precios ni plazos. No te despidas ni firmes. Devuelve SOLO el texto del mensaje.` +
      (extra ? `\nTen en cuenta esta indicación del negocio: "${String(extra).slice(0, 300)}"` : '')

    const out = await chat({
      provider, model, apiKey,
      messages: [{ role: 'system', content: sys }, ...history],
      maxTokens: 200, temperature: 0.5,
    })
    const text = typeof out === 'string' ? out.trim() : ''
    return text && text.length > 3 ? text : null
  } catch { return null }
}

module.exports = { transferResolve }
