'use strict'
/**
 * Conversión de audio webm/opus (lo que graba el navegador) a ogg/opus, que es
 * el formato que acepta WhatsApp Cloud API. Usa ffmpeg (instalado en la imagen)
 * vía stdin/stdout, sin tocar disco.
 */

const { spawn } = require('child_process')

function convertWebmToOgg(buffer) {
  return new Promise((resolve, reject) => {
    let ff
    try {
      ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', 'pipe:1'])
    } catch (e) { return reject(e) }
    const chunks = []
    let errBuf = ''
    ff.stdout.on('data', d => chunks.push(d))
    ff.stderr.on('data', d => { errBuf += d.toString() })
    ff.on('error', reject)
    ff.on('close', code => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks))
      else reject(new Error('ffmpeg falló (' + code + '): ' + errBuf.slice(0, 200)))
    })
    ff.stdin.on('error', () => {}) // EPIPE si ffmpeg cierra antes
    ff.stdin.write(buffer)
    ff.stdin.end()
  })
}

module.exports = { convertWebmToOgg }
