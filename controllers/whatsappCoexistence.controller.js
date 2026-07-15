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
    // IMPORTANTE (historial/recurrentes): para recibir la sincronización de los 6
    // meses de historial y los ecos del móvil, la app GLOBAL de Meta debe tener
    // activados los campos de webhook `history`, `smb_app_state_sync` y
    // `smb_message_echoes` (App Dashboard → WhatsApp → Configuration → Webhook
    // fields). Los campos se configuran a nivel de app, no por WABA; esta llamada
    // solo conecta el WABA a la app.
    let subscribed = false
    if (waba) {
      try {
        const subRes = await fetch(`${GRAPH}/${waba}/subscribed_apps`, {
          method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
        })
        const subData = await subRes.json().catch(() => ({}))
        subscribed = subRes.ok && (subData.success !== false)
        if (subRes.ok) console.log('[coexistence] WABA suscrito', waba, '— historial: depende de los webhook fields activos en la app de Meta')
        else console.warn('[coexistence] subscribed_apps:', subData?.error?.message)
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

    // 5) Disparar la sincronización de CONTACTOS e HISTORIAL. NO es automática: Meta
    //    exige pedirla explícitamente vía SMB App Data API tras suscribir la app al
    //    WABA. Primero contactos (smb_app_state_sync) y luego historial (history, hasta
    //    6 meses). Meta enviará los webhooks en las horas siguientes. Solo se puede
    //    pedir una vez por onboarding y hay 24h de plazo → por eso, para traer el
    //    historial de un número ya conectado, hay que desconectar y reconectar.
    let contactsSynced = false, historySynced = false
    const smbSync = async (syncType) => {
      try {
        const r = await fetch(`${GRAPH}/${phoneId}/smb_app_data`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
        })
        const d = await r.json().catch(() => ({}))
        if (r.ok && d?.error == null) { console.log(`[coexistence] sync '${syncType}' solicitado OK para ${phoneId}`); return true }
        console.warn(`[coexistence] sync '${syncType}' falló:`, d?.error?.message || `HTTP ${r.status}`)
      } catch (e) { console.warn(`[coexistence] sync '${syncType}' error:`, e.message) }
      return false
    }
    contactsSynced = await smbSync('smb_app_state_sync')   // 1) contactos
    historySynced  = await smbSync('history')              // 2) historial (6 meses)

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
        historySync: historySynced,
        contactsSync: contactsSynced,
      },
    })
  } catch (e) {
    console.error('[coexistence exchange]', e.message)
    res.status(400).json({ error: e.message || 'No se pudo completar la conexión por coexistencia' })
  }
}

module.exports = { getConfig, exchange }
