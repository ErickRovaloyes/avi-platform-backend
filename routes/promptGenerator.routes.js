'use strict'
const router = require('express').Router()
const multer = require('multer')
const { authMiddleware } = require('../auth')
const ctrl = require('../controllers/promptGenerator.controller')

const upload = multer({
  storage: multer.memoryStorage(),
  // Hard ceiling. Effective per-upload limit is platform_settings.prompt_generator_max_file_mb
  // (default 30 MB, super admin can change it up to 100 MB).
  limits: { fileSize: 100 * 1024 * 1024 },
})

router.post('/superadmin/generate-prompt-from-doc', authMiddleware, upload.single('file'), ctrl.generateFromDoc)
router.post('/accounts/:accId/change-agent/classify', authMiddleware, ctrl.classifyChange)
// Extrae el texto de un archivo adjuntado al Agente de Cambios (.docx/.pdf/.txt/.md)
// para que el modelo lo tenga en cuenta al proponer el cambio.
router.post('/accounts/:accId/change-agent/extract', authMiddleware, upload.single('file'), ctrl.extractForChange)

module.exports = router
