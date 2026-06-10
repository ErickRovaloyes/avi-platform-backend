'use strict'
/**
 * Conversión de audio webm/opus (lo que graba el navegador) a ogg/opus mono,
 * el formato de nota de voz que acepta y reproduce WhatsApp Cloud API.
 *
 * IMPORTANTE: usamos archivos temporales (no pipes). El contenedor webm/matroska
 * necesita "seek" para leer su índice; con stdin (no seekable) ffmpeg produce un
 * ogg corrupto que WhatsApp muestra como "audio ya no está disponible".
 */

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

function convertWebmToOgg(buffer) {
  const base = path.join(os.tmpdir(), `avi_${Date.now()}_${Math.random().toString(36).slice(2)}`)
  const inF = base + '.webm'
  const outF = base + '.ogg'
  return new Promise((resolve, reject) => {
    fs.promises.writeFile(inF, buffer).then(() => {
      const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-i', inF, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', outF])
      let err = ''
      ff.stderr.on('data', d => { err += d.toString() })
      ff.on('error', e => { cleanup(); reject(e) })
      ff.on('close', async code => {
        try {
          if (code === 0) {
            const out = await fs.promises.readFile(outF)
            if (!out.length) return reject(new Error('ffmpeg generó un audio vacío'))
            resolve(out)
          } else {
            reject(new Error('ffmpeg falló (' + code + '): ' + err.slice(0, 200)))
          }
        } catch (e) { reject(e) } finally { cleanup() }
      })
    }).catch(reject)

    function cleanup() {
      fs.promises.unlink(inF).catch(() => {})
      fs.promises.unlink(outF).catch(() => {})
    }
  })
}

module.exports = { convertWebmToOgg }
