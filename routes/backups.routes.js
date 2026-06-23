'use strict'
const router = require('express').Router()
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/backups.controller')

router.get('/:accId/:agId',                 authMiddleware, ctrl.listBackups)
router.post('/:accId/:agId',                authMiddleware, ctrl.createBackup)
router.delete('/:accId/:agId/:bkId',        authMiddleware, ctrl.deleteBackup)
router.post('/:accId/:agId/:bkId/restore',  authMiddleware, ctrl.restoreBackup)
router.get('/:accId/:agId/settings',        authMiddleware, ctrl.getBackupSettings)
router.put('/:accId/:agId/settings',        authMiddleware, ctrl.putBackupSettings)
router.get('/:accId/:agId/:bkId/data',      authMiddleware, ctrl.getBackup)

module.exports = router
