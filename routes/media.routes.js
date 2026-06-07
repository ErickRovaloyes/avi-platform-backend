'use strict'
const router = require('express').Router()
const multer = require('multer')
const { authMiddleware, optionalAuth } = require('../auth')
const ctrl = require('../controllers/media.controller')

const upload = multer({
  storage: multer.memoryStorage(),
  // Hard ceiling — the real per-upload limit comes from platform_settings.media_max_size_mb
  // (default 30 MB, editable by the super admin up to 100 MB).
  // Multer rejects above this hardcap; the controller validates the configured limit.
  limits: { fileSize: 100 * 1024 * 1024 },
})

// Upload — optionalAuth so the public webchat (no JWT) can also send media
router.post('/conversations/:accId/:agId/:convId/media',
  optionalAuth, upload.single('file'), ctrl.uploadMedia)

// Generic upload for team chat / support (authenticated)
router.post('/media/:accId/upload',
  authMiddleware, upload.single('file'), ctrl.uploadGenericMedia)

// Public download — IDs are unguessable; needed for <img>/<audio>/<video> in webchat
router.get('/media/:accId/:mediaId',     ctrl.getMedia)
router.get('/media/:accId/:mediaId/raw', ctrl.getMediaRaw)

module.exports = router
