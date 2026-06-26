'use strict'

let _io = null

module.exports = {
  init(io) { _io = io },

  emit(accountId, event, data) {
    if (_io) _io.to(`acc:${accountId}`).emit(event, data)
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
