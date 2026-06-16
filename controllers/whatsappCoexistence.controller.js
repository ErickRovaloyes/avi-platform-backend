'use strict'
/**
 * WhatsApp Coexistence — onboarding por Embedded Signup contra la app GLOBAL de
 * Meta (configurada en el Super Panel). El cliente conecta su WhatsApp Business
 * existente con un solo clic, sin ingresar App ID/Secret.
 *
 * Flujo:
 *   1) Frontend lanza el Embedded Signup (FB.login con config_id) → devuelve un
 *      `code` y, por el evento de sesión, el `phone_number_id` + `waba_id`.
 *   2) Este endpoint intercambia el code por un token (System User de integración,
 *      de larga duración) usando el App Secret global.
 *   3) Suscribe la app de Meta al WABA para recibir webhooks.
 *   4) Devuelve la config del canal (incluido el accessToken) para guardarla en el
 *      canal de WhatsApp del agente. El secret nunca sale al frontend.
 */

const pool = require('../db')

const GRAPH_VERSION = 'v19.0'
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

async function globalMetaApp() {
  const [[r]] = await pool.query('SELECT meta_app_id, meta_app_secret, meta_config_id FROM platform_settings WHERE id=1')
  return { appId: r?.meta_app_id || '', appSecret: r?.meta_app_secret || '', configId: r?.meta_config_id || '' }
}

// GET /api/whatsapp/coexistence/config → datos públicos para el Embedded Signup.
const getConfig = async (req, res) => {
  try {
    const { appId, configId } = await globalMetaApp()
    res.json({ appId, configId, graphVersion: GRAPH_VERSION, ready: !!(appId && configId) })
  } catch { res.status(500).json({ error: 'Error interno' }) }
}

// POST /api/whatsapp/coexistence/exchange
// body: { code, phoneNumberId, wabaId, displayPhone?, verifiedName? }
const exchange = async (req, res) => {
  const { code, phoneNumberId, wabaId, displayPhone, verifiedName } = req.body || {}
  if (!code) return res.status(400).json({ error: 'Falta el código de autorización de Meta' })
  try {
    const { appId, appSecret } = await globalMetaApp()
    if (!appId || !appSecret) {
      return res.status(400).json({ error: 'La app global de Meta no está configurada (Super Panel → Integraciones: App ID, App Secret y Config ID).' })
    }

    // 1) Intercambiar el code por un access token (System User de integración).
    const tokenUrl = `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`
    const tokenRes = await fetch(tokenUrl)
    const tokenData = await tokenRes.json().catch(() => ({}))
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData?.error?.message || 'No se pudo intercambiar el código por un token')
    }
    const accessToken = tokenData.access_token

    let waba = wabaId || null
    let phoneId = phoneNumberId || null
    let dPhone = displayPhone || ''
    let vName = verifiedName || ''
    let businessId = null

    // 2) Si no llegó el waba/phone desde el Embedded Signup, intentar descubrirlo.
    if (!waba) {
      try {
        const r = await fetch(`${GRAPH}/me/businesses?fields=id,name,owned_whatsapp_business_accounts{id,phone_numbers{id,display_phone_number,verified_name}}&access_token=${accessToken}`)
        const d = await r.json().catch(() => ({}))
        const biz = d?.data?.[0]
        const w = biz?.owned_whatsapp_business_accounts?.data?.[0]
        if (w) {
          waba = w.id; businessId = biz.id
          const ph = w.phone_numbers?.data?.[0]
          if (ph && !phoneId) { phoneId = ph.id; dPhone = dPhone || ph.display_phone_number; vName = vName || ph.verified_name }
        }
      } catch { /* best-effort */ }
    }

    // 3) Suscribir la app al WABA → habilita la recepción de webhooks.
    let subscribed = false
    if (waba) {
      try {
        const subRes = await fetch(`${GRAPH}/${waba}/subscribed_apps`, {
          method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
        })
        const subData = await subRes.json().catch(() => ({}))
        subscribed = subRes.ok && (subData.success !== false)
        if (!subRes.ok) console.warn('[coexistence] subscribed_apps:', subData?.error?.message)
      } catch (e) { console.warn('[coexistence] subscribe error', e.message) }
    }

    // 4) Completar datos del número si faltan.
    if (phoneId && (!dPhone || !vName)) {
      try {
        const pr = await fetch(`${GRAPH}/${phoneId}?fields=display_phone_number,verified_name&access_token=${accessToken}`)
        const pd = await pr.json().catch(() => ({}))
        if (pr.ok) { dPhone = dPhone || pd.display_phone_number || ''; vName = vName || pd.verified_name || '' }
      } catch { /* best-effort */ }
    }

    if (!phoneId) {
      return res.status(400).json({ error: 'No se pudo determinar el número de WhatsApp. Reintenta el proceso de conexión.' })
    }

    res.json({
      config: {
        phoneNumberId: phoneId,
        accessToken,
        businessAccountId: businessId || waba || '',
        wabaId: waba || '',
        displayPhone: dPhone,
        verifiedName: vName,
        mode: 'coexistence',
        coexistence: true,
        subscribed,
      },
    })
  } catch (e) {
    console.error('[coexistence exchange]', e.message)
    res.status(400).json({ error: e.message || 'No se pudo completar la conexión por coexistencia' })
  }
}

module.exports = { getConfig, exchange }
