'use strict'

let _io = null

module.exports = {
  init(io) { _io = io },

  emit(accountId, event, data) {
    if (_io) _io.to(`acc:${accountId}`).emit(event, data)
    // Los miembros con `soloAsignadas` no están en `acc:`, así que se les reparte a mano lo de
    // SUS conversaciones. Cuando la cuenta no tiene ninguno —el caso normal— esto no consulta
    // nada. Los eventos sin `convId` (convos:updated) llegan a todos: solo piden una recarga,
    // y esa recarga ya sale filtrada del servidor.
    if (_io) {
      const visibilidad = require('./visibilidadConvos')
      const reparte = data?.convId
        ? visibilidad.destinatariosRestringidos(accountId, data.convId)
        : visibilidad.miembrosRestringidos(accountId).then(s => [...s])
      reparte
        .then(ids => { for (const id of ids) _io.to(`mem:${id}`).emit(event, data) })
        .catch(e => console.warn('[socket] reparto restringido:', e.message))
    }
    // Push a la app móvil cuando llega un mensaje del CLIENTE (best-effort, no bloquea).
    if (event === 'message:new' && data?.message?.sender === 'user') {
      try { require('./push').onInboundMessage(accountId, data) } catch (e) { /* no romper el emit */ }
    }
  },

  emitToConv(convId, event, data) {
    if (_io) _io.to(`conv:${convId}`).emit(event, data)
  },

  // Targeted emit to a single member (used for direct messages).
  emitToMember(memberId, event, data) {
    if (_io) _io.to(`mem:${memberId}`).emit(event, data)
  },

  broadcast(event, data) {
    if (_io) _io.emit(event, data)
  },

  get io() { return _io },
}
