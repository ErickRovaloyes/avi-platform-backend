'use strict'
/**
 * Registro de handlers de herramientas IA.
 *
 * Una herramienta del catálogo puede llevar código propio. Ese código vive AQUÍ, en el
 * repositorio: se escribe con git, se prueba y puede usar la base de datos o la API que haga
 * falta. La ficha del catálogo solo guarda su clave.
 *
 * A propósito NO se guarda JavaScript en la base para ejecutarlo en un `vm`: el aislador de
 * Node no es una frontera de seguridad, y un escape ahí compromete la plataforma entera.
 *
 * Para añadir una herramienta, basta con dejar un archivo en esta carpeta. La lista se construye
 * LEYENDO el directorio, no manteniendo un índice a mano — mantener una lista en paralelo con la
 * realidad ya ha fallado varias veces en este proyecto.
 *
 * Forma de un handler:
 *
 *   module.exports = {
 *     clave: 'cotizadorSeguros',          // identificador estable; es lo que guarda la ficha
 *     nombre: 'Cotizador de seguros',     // para elegirlo en el superpanel
 *     descripcion: 'Qué hace, en una línea.',
 *     parametros: [                       // lo que el modelo debe enviar
 *       { name: 'edad', type: 'number', required: true, description: 'Edad del titular' },
 *     ],
 *     async ejecutar(ctx, args) { return 'texto que lee el asistente' },
 *   }
 *
 * `ctx` trae `accId`, `agId`, `convId` y las variables de la conversación.
 */
const fs = require('fs')
const path = require('path')

const _registro = new Map()
let _cargado = false

function cargar() {
  if (_cargado) return _registro
  _cargado = true
  let archivos = []
  try { archivos = fs.readdirSync(__dirname) } catch { archivos = [] }
  for (const nombre of archivos) {
    if (nombre === 'index.js' || !nombre.endsWith('.js')) continue
    try {
      // Un archivo puede exportar UN handler o una LISTA: cuatro capacidades del mismo
      // servicio viven mejor juntas que en cuatro archivos casi identicos.
      const exportado = require(path.join(__dirname, nombre))
      for (const h of (Array.isArray(exportado) ? exportado : [exportado])) {
        // Sin clave o sin ejecutar no sirve de nada; mejor decirlo al arrancar que
        // descubrirlo en mitad de una conversacion con un cliente.
        if (!h || !h.clave || typeof h.ejecutar !== 'function') {
          console.warn(`[toolHandlers] ${nombre}: un handler sin clave o sin ejecutar, se ignora`)
          continue
        }
        if (_registro.has(h.clave)) {
          console.warn(`[toolHandlers] clave duplicada "${h.clave}" en ${nombre}, se ignora`)
          continue
        }
        _registro.set(h.clave, h)
      }
    } catch (e) {
      console.error(`[toolHandlers] ${nombre} no se pudo cargar:`, e.message)
    }
  }
  return _registro
}

/** Los handlers disponibles, para que el superpanel los ofrezca en una lista. */
function listar() {
  return [...cargar().values()].map(h => ({
    clave: h.clave,
    nombre: h.nombre || h.clave,
    descripcion: h.descripcion || '',
    parametros: h.parametros || [],
    necesitaConexion: h.necesitaConexion || null,
  }))
}

/** El handler de una clave, o null si esa ficha apunta a algo que ya no existe. */
function obtener(clave) {
  return cargar().get(clave) || null
}

module.exports = { listar, obtener }
