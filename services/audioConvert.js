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

// Convierte CUALQUIER audio (webm del navegador, m4a/aac del móvil, mp3, wav…) a
// ogg/opus mono — el formato de nota de voz que acepta y reproduce WhatsApp.
function convertAudioToOgg(buffer, inputExt = 'webm') {
  const base = path.join(os.tmpdir(), `avi_${Date.now()}_${Math.random().toString(36).slice(2)}`)
  const safeExt = String(inputExt || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin'
  const inF = base + '.' + safeExt
  const outF = base + '.ogg'
  return new Promise((resolve, reject) => {
    fs.promises.writeFile(inF, buffer).then(() => {
      // Parámetros pensados para notas de voz de WhatsApp:
      //  -application voip (voz), 48kHz mono opus, metadata/timestamps limpios.
      const ff = spawn('ffmpeg', [
        '-loglevel', 'error', '-y', '-i', inF,
        '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
        '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
        '-avoid_negative_ts', 'make_zero', '-f', 'ogg', outF,
      ])
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

// Compat: el navegador graba webm; el móvil graba m4a. Ambos pasan por el mismo
// conversor genérico.
function convertWebmToOgg(buffer) { return convertAudioToOgg(buffer, 'webm') }

module.exports = { convertWebmToOgg, convertAudioToOgg }
