'use strict'
/**
 * Octorate: la herramienta del catálogo que HABILITA la integración.
 *
 * No es una función que el asistente llame. Es un permiso: mientras la cuenta la tenga
 * instalada, Octorate aparece como opción de conexión en Zona IA → PMS. A partir de ahí, quien
 * responde al cliente es la herramienta de PMS que ya existe (`ver_habitaciones`,
 * `ver_disponibilidad_hotel`, `reservar_habitacion`…), que es agnóstica del proveedor.
 *
 * Se hizo así después de un rodeo: la primera versión eran CUATRO herramientas con código que
 * duplicaban esa herramienta de PMS. Dos caminos para reservar acaban desincronizándose, así que
 * ahora hay uno solo y este handler únicamente abre la puerta.
 *
 * `tipo: 'pms_provider'` es lo que hace que `buildToolDefs` la omita: una herramienta invocable
 * que no hace nada es peor que no tenerla, porque el modelo la llama y se queda esperando.
 */
module.exports = {
  clave: 'octorate',
  nombre: 'Octorate',
  descripcion:
    'Conecta el hotel con Octorate (PMS, channel manager y motor de reservas). Al instalarla, ' +
    'Octorate queda disponible en Zona IA → PMS para autorizar la conexión. Después el asistente ' +
    'puede mostrar habitaciones con fotos, consultar disponibilidad y precios reales, crear ' +
    'reservas y gestionarlas — y los mensajes de huéspedes de Airbnb y Booking entran al inbox.',

  // No es ejecutable: es un permiso. Ver el comentario de arriba.
  tipo: 'pms_provider',
  provider: 'octorate',
  necesitaConexion: 'octorate',
  parametros: [],

  async ejecutar() {
    // No debería llamarse nunca (buildToolDefs no la ofrece al modelo). Si por alguna vía
    // llegara aquí, se responde algo útil en vez de un error sin sentido.
    return 'Octorate está instalado. Para consultar habitaciones o reservar, usa las herramientas de PMS del asistente.'
  },
}
