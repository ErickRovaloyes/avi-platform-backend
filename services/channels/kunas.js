'use strict'
/**
 * Kunas / HotelSync como CHANNEL MANAGER (sincronización de inventario con OTAs).
 *
 * OJO — esto NO es la integración de reservas. La de verdad, la que usa el asistente para
 * buscar, cotizar, reservar, consultar y cancelar, vive en `services/pmsProviders.js`
 * (proveedor `kunas`) y habla con el motor de reservas `/api/engine/*`.
 *
 * Antes este archivo declaraba un REST genérico con `Authorization: Bearer` y rutas
 * `/rooms`, `/reservations`, `/availability`. Nada de eso existe en HotelSync: su API es
 * POST a `/api/...` con `{token, key, id_properties}` en el CUERPO, y la autenticación es
 * un login que devuelve una `pkey`. O sea, este adaptador no podía funcionar, y tenerlo
 * aquí hacía parecer que la integración estaba hecha por duplicado.
 *
 * Se deja declarado —sin implementación— para que la UI siga listando el proveedor en la
 * pestaña de canales, pero sin prometer llamadas que fallarían. Cuando haya que sincronizar
 * inventario, se implementa sobre `/api/avail/edit/avail` y `/api/prices/edit/prices`, que
 * son los endpoints reales, reutilizando el login de `pmsProviders.js` en vez de montar otro.
 */
const { defineAdapter } = require('./base')

module.exports = defineAdapter({
  id: 'kunas',
  requires: ['token'],
  credentialFields: () => [
    { key: 'token', label: 'Token de partner', type: 'password', required: true, help: 'Lo entrega el soporte de HotelSync (hotelsync.com/api.php#connectivityPartner).' },
    { key: 'username', label: 'Usuario', type: 'text', required: true, help: 'El de la propiedad en app.hotelsync.com.' },
    { key: 'password', label: 'Contraseña', type: 'password', required: true },
    { key: 'propertyId', label: 'ID de propiedad', type: 'text', required: false, help: 'Opcional: con él, el flujo de reservas funciona sin necesidad de login.' },
  ],
  async testConnection() {
    return { ok: false, message: 'La conexión de Kunas se configura y se prueba en la pestaña PMS, no aquí: es la misma cuenta.' }
  },
})
