'use strict'
/**
 * Asistente general de la PLATAFORMA: responde dudas del usuario (dueño/asesor) sobre
 * CÓMO usar AVI, con base en la documentación de la plataforma. Reutiliza el Modelo IA
 * de Negocio (Super Panel) y la resolución de clave, igual que businessCopilot.
 */
const pool = require('../db')
const { callAI, detectProvider, resolveProviderKey } = require('../controllers/promptGenerator.controller')

async function businessModel() {
  try { const [[ps]] = await pool.query('SELECT business_ai_model FROM platform_settings WHERE id=1'); return ps?.business_ai_model || 'gpt-4o-mini' }
  catch { return 'gpt-4o-mini' }
}

// Base de conocimiento de la plataforma (portada del Centro de Ayuda: qué/cómo/pasos).
const PLATFORM_KB = `
# Bandeja de conversaciones
Centro donde llegan y se responden todos los chats (WhatsApp, Messenger, Instagram, Webchat). La IA responde sola o un asesor toma el control. Se puede filtrar por canal, etiquetas, estado y asignación.
Pasos: abrir "Bandeja"; seleccionar una conversación; activar/desactivar la IA con el interruptor del encabezado; escribir en "Respuesta manual" (adjuntar imágenes/audios/documentos); usar el panel lateral (ℹ) para datos del cliente, etiquetas y agendar cita.

# Zona IA (el agente)
Define el "cerebro": prompt (personalidad/instrucciones), herramientas y variables. El prompt activo guía las respuestas; las herramientas dan capacidades (agendar, cobrar, tienda/catálogo). Pasos: entrar a "Zona IA"; editar el prompt o usar el Agente de Cambios; activar el prompt a usar; asignar herramientas.

# Canales (WhatsApp, Messenger, Instagram, Webchat)
Vías por las que te escriben. WhatsApp se conecta con 1 clic (Embedded Signup); Messenger/Instagram con "Conectar en 3 pasos" (login con Facebook, marcar tu Página, autorizar); Webchat genera un enlace/widget público. Pasos: Configuración → Canales → conectar; para Messenger/IG marca tu Página antes de continuar; verifica estado "Conectado".

# Flujos (automatizaciones)
Secuencias automáticas (nodos: mensaje, condición, IA, CRM, agenda, API…) con un disparador (inicio de conversación, palabra clave, manual o herramienta IA). Pasos: "Flujos" → "Nuevo flujo"; arrastrar y conectar nodos; o usar "✨ Diseñar con IA"; definir disparador y guardar.

# CRM y Pipeline
Gestiona contactos y mueve oportunidades por etapas (embudos). Cada conversación puede vincularse a un contacto y a una tarjeta del pipeline. Pasos: abrir "CRM"; crear/editar pipelines y etapas; arrastrar tarjetas entre etapas; filtrar y etiquetar contactos.

# Campañas (mensajes masivos)
Envía un mensaje a muchos contactos (promos, avisos, recordatorios). Se elige audiencia (etiqueta/segmento) y contenido, respetando reglas del canal (plantillas de WhatsApp). Pasos: "Masivos"; definir audiencia y mensaje/plantilla; revisar destinatarios; enviar o programar.

# Calendarios y agendamiento
La IA o un asesor agenda citas/reservas según disponibilidad. Se definen horarios, duración y formulario; hay un enlace público de reservas y también se agenda manual desde el chat. Pasos: Configuración → Calendarios → crear y definir disponibilidad; compartir enlace o dejar que la IA lo envíe; para agendar tú: en el chat "📅 Agendar cita".

# Catálogo de Meta
Conecta el catálogo de productos de tu cuenta de Meta (Commerce) y lee su contenido. Reutiliza el token de tu WhatsApp o pega el Catalog ID. Pasos: Configuración → Catálogo Meta → "Detectar catálogos" (requiere WhatsApp) o manual; conectar y revisar productos.

# Conocimiento (RAG)
Base de conocimiento que el agente consulta para responder con info de tu negocio (precios, políticas, FAQs). Subes documentos/notas → se trocean en fragmentos que la IA recupera. Pasos: subir documentos; asignar la base al prompt; hacer preguntas de prueba.

# Métricas
Analítica de uso: conversaciones por canal, consumo y desempeño del agente. Pasos: abrir "Métricas" y revisar tendencias.

# Equipo, roles y chat interno
Administra miembros, permisos y comunicación interna. Cada miembro tiene un rol con permisos (qué pestañas ve); el "Chat de equipo" permite canales y mensajes directos. También hay "Equipos" para agrupar miembros. Pasos: Configuración → Equipo: crear asesores y asignar rol; crear roles con permisos; usar la pestaña "Equipo".

# Notificaciones
Eliges qué avisos recibir (mensaje nuevo, chat nuevo, transferencia, soporte, equipo, interno) y por qué canal (Web activo; Correo/SMS/App próximamente). Se guardan por usuario. Pasos: abrir tu Perfil (avatar arriba a la derecha) → "🔔 Notificaciones".

# Módulos y suscripción
Los módulos son las funcionalidades disponibles; el plan define consumo y límites. Un módulo activo habilita su pestaña. Pasos: Configuración → Módulos (revisar/activar); Configuración → Cuenta/Suscripción (plan, consumo, vencimiento).

# Tienda (WooCommerce / Shopify)
Conecta tu tienda para que la IA busque productos, los envíe con fotos, cree pedidos con link de pago y confirme el pago. Se puede desactivar la gestión de pedidos (solo info) y configurar recuperación de carrito abandonado (chat y web). Configuración: Zona IA → Tienda.

# Copiloto de negocio
Un chat donde el dueño pregunta por sus datos (ventas, clientes, atención, pipeline, citas) y la IA responde con base en el CRM. Está en el CRM y también como bolita flotante (pestaña "Negocio").
`

const SYS = `Eres el asistente de AYUDA de la plataforma AVI (SaaS de atención al cliente con IA multicanal).
Respondes al USUARIO de la plataforma (dueño o asesor) sus dudas sobre CÓMO usar AVI, con base ÚNICAMENTE
en la DOCUMENTACIÓN de abajo. Reglas:
- Responde en español, claro y práctico (máx. ~6 líneas). Incluye PASOS concretos cuando aplique.
- Usa solo lo que está en la documentación; NO inventes funciones que no existan.
- Si la duda no está cubierta, dilo y sugiere revisar el Centro de Ayuda (❓) o contactar a soporte.

DOCUMENTACIÓN DE LA PLATAFORMA:
${PLATFORM_KB}`

async function ask(accId, question) {
  const model = await businessModel()
  const provider = detectProvider(model)
  const { key: apiKey } = await resolveProviderKey(accId, provider)
  if (!apiKey) return { ok: false, error: `Sin API key para ${provider}. Configúrala en la cuenta o en el Super Panel.` }
  const r = await callAI({ provider, model, apiKey, systemPrompt: SYS, userPrompt: String(question || '').slice(0, 500), maxTokens: 450, temperature: 0.3 })
  return { ok: true, answer: (r.text || '').trim(), model }
}

module.exports = { ask }
