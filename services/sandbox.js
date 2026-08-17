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
 * Deja un valor de columna JSON como TEXTO.
 *
 * `db.js` no fija `typeCast`, así que mysql2 devuelve las columnas JSON **ya parseadas**: lo que
 * sale de un SELECT es un array o un objeto, no una cadena. Y al pasar un array como parámetro
 * de un `?`, mysql2 lo EXPANDE en una lista separada por comas — de ahí el
 * «Column count doesn't match value count at row 1» al insertar.
 *
 * Además el remapeo de ids se hacía por texto y estaba guardado tras un `typeof === 'string'`,
 * así que con valores parseados no llegaba a ejecutarse: la copia habría apuntado a los flujos
 * y herramientas de PRODUCCIÓN. Normalizar aquí arregla las dos cosas a la vez.
 */
function comoTexto(v, porDefecto = '[]') {
  if (v == null) return porDefecto
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** Sustituye ids dentro de un JSON serializado, respetando las comillas para no pillar prefijos. */
function remapear(texto, mapa) {
  let out = texto
  for (const [viejo, nuevo] of mapa) out = out.split(`"${viejo}"`).join(`"${nuevo}"`)
  return out
}

// Canales INTERNOS: no salen a ningún proveedor y no llevan credenciales. El webchat vive en
// una página propia (con la url del entorno, que ningún cliente conoce) y el de pruebas es el
// chat interno del panel. Son justamente los que hay que dejar VIVOS: sin ellos no se puede
// probar nada, que es para lo que existe el entorno.
const CANALES_INTERNOS = new Set(['webchat', 'test'])

/**
 * Deja inertes los canales que SALEN AL MUNDO —WhatsApp, Messenger, Instagram—: sin
 * credenciales y marcados como desconectados. Se conserva el tipo y el nombre para que la
 * configuración se reconozca, pero no puede salir ni un mensaje a un cliente real.
 *
 * Los internos se copian tal cual. Desconectarlos también fue un error: dejaba el entorno sin
 * canal de pruebas, así que el asistente no respondía y no se creaba ninguna conversación.
 */
function desconectarCanales(channelsJson) {
  // Vale tanto si llega como texto (lo que asumía la prueba) como ya parseado (lo que llega de
  // verdad desde mysql2).
  const canales = typeof channelsJson === 'string' ? parseJ(channelsJson, []) : (channelsJson || [])
  if (!Array.isArray(canales)) return '[]'
  return JSON.stringify(canales.map(c => (
    CANALES_INTERNOS.has(c.type)
      ? c
      : {
          id: c.id, type: c.type, name: c.name,
          status: 'disconnected',
          config: {},              // fuera tokens, phoneNumberId, pageId… todo
          sandboxNote: 'Canal desconectado en el entorno de pruebas',
        }
  )))
}

/**
 * Las columnas REALES de una tabla, preguntándoselas a la base de datos.
 *
 * Antes se listaban a mano, sacadas del esquema con una expresión regular, y esa lista se
 * quedaba corta una y otra vez. La peor: `flows.trigger` va escrita entre comillas invertidas
 * —es palabra reservada— y la expresión no casaba con esa línea, así que los flujos copiados
 * quedaban SIN trigger. El motor elige los flujos por su trigger, de modo que en el entorno no
 * se disparaba ninguno y el asistente no respondía a nada.
 *
 * Preguntando a la base de datos eso deja de poder pasar, y las migraciones futuras se copian
 * solas.
 */
const _cacheCols = new Map()
async function columnasDe(tabla) {
  if (_cacheCols.has(tabla)) return _cacheCols.get(tabla)
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
    [tabla]
  )
  const cols = rows.map(r => r.c)
  _cacheCols.set(tabla, cols)
  return cols
}

/**
 * Copia las filas de una tabla a la cuenta de pruebas.
 *
 * Se copian TODAS las columnas; `cambios` decide las que no viajan tal cual (el id nuevo, las
 * referencias remapeadas, lo que debe ir vacío). Los nombres van entrecomillados para que
 * `trigger` y cualquier otra palabra reservada dejen de ser un caso especial.
 */
async function copiarTabla(tabla, padreId, sandboxId, { prefijoId, cambios = {} } = {}) {
  const cols = await columnasDe(tabla)
  if (!cols.length) return new Map()
  const [filas] = await pool.query(`SELECT * FROM \`${tabla}\` WHERE account_id=?`, [padreId])
  const mapa = new Map()
  const sql = `INSERT INTO \`${tabla}\` (${cols.map(c => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`

  const valorDe = (c, fila) => {
    const v = cambios[c]
    return typeof v === 'function' ? v(fila) : v
  }
  for (const fila of filas) {
    // Los `cambios` mandan también sobre el id: cuando el id nuevo se calculó ANTES (los
    // flujos, que se referencian entre sí) viene de ahí. Resolverlo después era el fallo:
    // sin `prefijoId` la copia conservaba el id original y apuntaba a producción.
    const idNuevo = Object.prototype.hasOwnProperty.call(cambios, 'id') ? valorDe('id', fila)
      : prefijoId ? nuevoId(prefijoId)
      : fila.id
    mapa.set(fila.id, idNuevo)
    const vals = cols.map(c => {
      if (c === 'id') return idNuevo
      if (c === 'account_id') return sandboxId
      if (Object.prototype.hasOwnProperty.call(cambios, c)) return valorDe(c, fila)
      // Nunca un valor crudo: mysql2 expande un array en varios valores y descuadra la consulta.
      return fila[c] !== null && typeof fila[c] === 'object' ? JSON.stringify(fila[c]) : fila[c]
    })
    await pool.query(sql, vals).catch(e => console.warn(`[sandbox] ${tabla}:`, e.message))
  }
  return mapa
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

  // 1) Los FLUJOS primero: todo lo demás los referencia por id.
  //    Se necesitan los ids nuevos ANTES de insertar, porque un flujo puede saltar a otro y esas
  //    referencias viven dentro de sus propios nodos.
  const [flujos] = await pool.query('SELECT id FROM flows WHERE account_id=?', [padreId])
  const mapaFlujos = new Map(flujos.map(f => [f.id, nuevoId('flow')]))
  await copiarTabla('flows', padreId, sandboxId, {
    cambios: {
      id: f => mapaFlujos.get(f.id),
      nodes: f => remapear(comoTexto(f.nodes), mapaFlujos),
    },
  })

  // 2) Herramientas: apuntan a un flujo.
  const mapaTools = await copiarTabla('ai_tools', padreId, sandboxId, {
    prefijoId: 'tool',
    cambios: { flow_id: t => mapaFlujos.get(t.flow_id) || null },
  })

  // 3) Agentes: referencian herramientas y flujos por todos lados.
  //    `fallback_flow_id` es el flujo de entrada y `test_flow_id` el del canal de pruebas: sin
  //    remapearlos, el entorno se queda sin nada que ejecutar.
  await copiarTabla('agents', padreId, sandboxId, {
    prefijoId: 'ag',
    cambios: {
      prompts: g => remapear(remapear(comoTexto(g.prompts), mapaTools), mapaFlujos),
      ai_tool_ids: g => {
        const ids = typeof g.ai_tool_ids === 'string' ? parseJ(g.ai_tool_ids, []) : (g.ai_tool_ids || [])
        return JSON.stringify((Array.isArray(ids) ? ids : []).map(x => mapaTools.get(x) || x))
      },
      channels: g => desconectarCanales(g.channels),
      fallback_flow_id: g => mapaFlujos.get(g.fallback_flow_id) || null,
      test_flow_id: g => mapaFlujos.get(g.test_flow_id) || null,
      // Contadores del reparto IA/humano: el entorno empieza de cero.
      rr_ai: 0, rr_total: 0,
    },
  })

  await copiarTabla('labels', padreId, sandboxId, { prefijoId: 'lb' })
  await copiarTabla('variables', padreId, sandboxId, { prefijoId: 'var' })
  // Los pipelines conservan sus etapas pero NO sus tarjetas: las tarjetas son negocio real.
  await copiarTabla('pipelines', padreId, sandboxId, { prefijoId: 'pipe', cambios: { cards: '[]' } })

  // 4) La configuración de la CUENTA. Se copian todas sus columnas menos las que la identifican:
  //    así el entorno hereda tienda, PMS, pedidos, pasarela, tema y zona horaria. Antes se
  //    copiaban tres campos a mano y el entorno se quedaba sin ninguna de esas integraciones.
  const NO_COPIAR_CUENTA = new Set(['id', 'name', 'sandbox_of', 'created_at'])
  const colsCuenta = (await columnasDe('accounts')).filter(c => !NO_COPIAR_CUENTA.has(c))
  if (colsCuenta.length) {
    const [[padre]] = await pool.query('SELECT * FROM accounts WHERE id=?', [padreId])
    if (padre) {
      await pool.query(
        `UPDATE accounts SET ${colsCuenta.map(c => `\`${c}\`=?`).join(', ')} WHERE id=?`,
        [...colsCuenta.map(c => (padre[c] !== null && typeof padre[c] === 'object' ? JSON.stringify(padre[c]) : padre[c])), sandboxId]
      ).catch(e => console.warn('[sandbox] config de cuenta:', e.message))
    }
  }
}

/** Copia a los miembros de la cuenta real para que entren al entorno con su mismo correo. */
async function copiarMiembros(padreId, sandboxId) {
  await pool.query('DELETE FROM members WHERE account_id=?', [sandboxId]).catch(() => {})
  // `agent_access` va vacío: los ids de agente del entorno son otros, así que copiarlo dejaría
  // a la gente sin acceso a ningún agente. Vacío = acceso a todos.
  await copiarTabla('members', padreId, sandboxId, { prefijoId: 'mem', cambios: { agent_access: '[]' } })
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
    // Fila mínima a propósito: solo lo que identifica a la cuenta. Todo lo demás —claves,
    // tienda, PMS, pedidos, pasarela, tema— lo rellena `volcarConfig` copiando las columnas
    // reales, así que aquí no hay ninguna lista que se pueda quedar corta.
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
