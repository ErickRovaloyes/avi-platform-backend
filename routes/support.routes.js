'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/support.controller')

router.get('/',                             authMiddleware, ctrl.getAllTickets)
router.post('/',                            authMiddleware, ctrl.createTicket)
router.post('/:ticketId/messages',          authMiddleware, ctrl.addMessage)
router.put('/:ticketId',                    authMiddleware, ctrl.updateTicket)
router.put('/:ticketId/status',             authMiddleware, ctrl.updateStatus)
router.put('/:ticketId/assign',             authMiddleware, ctrl.assignTicket)
router.put('/:ticketId/rating',             authMiddleware, ctrl.submitRating)
router.put('/:ticketId/take',               authMiddleware, ctrl.takeTicket)
router.put('/:ticketId/priority',           authMiddleware, ctrl.setPriority)
router.post('/:ticketId/notes',             authMiddleware, ctrl.addNote)
router.delete('/:ticketId/notes/:noteId',   authMiddleware, ctrl.deleteNote)
router.put('/:ticketId/eta',                authMiddleware, ctrl.setEta)

module.exports = router
