'use strict'
// Registro de adaptadores de canal/OTA.
const adapters = {
  airbnb: require('./airbnb'),
  booking: require('./booking'),
  hosroom: require('./hosroom'),
  kunas: require('./kunas'),
}
function getAdapter(provider) { return adapters[provider] || null }
// Esquemas de credenciales por proveedor → la UI dibuja los campos automáticamente.
function providerSchemas() {
  return Object.values(adapters).map(a => ({ provider: a.id, fields: a.credentialFields() }))
}
module.exports = { adapters, getAdapter, providerSchemas }
