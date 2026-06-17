'use strict'
// HosRoom (PMS / channel manager). REST con API key. Conectar = API key + endpoint.
const { createGenericRest } = require('./genericRest')
module.exports = createGenericRest({
  id: 'hosroom', label: 'HosRoom',
  defaults: { endpointHelp: 'URL base de la API de HosRoom (te la da HosRoom).', roomsPath: '/rooms', reservationsPath: '/reservations', availabilityPath: '/availability' },
})
