'use strict'
// Kunas (sistema de reservas / PMS). REST con API key. Conectar = API key + endpoint.
const { createGenericRest } = require('./genericRest')
module.exports = createGenericRest({
  id: 'kunas', label: 'Kunas',
  defaults: { endpointHelp: 'URL base de la API de Kunas (te la da Kunas).', roomsPath: '/rooms', reservationsPath: '/reservations', availabilityPath: '/availability' },
})
