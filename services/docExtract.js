'use strict'
// Extracción de texto de documentos (DOCX vía mammoth, PDF heurístico, txt/md).
// Reutilizado por el generador de prompts y el onboarding Demo.
const mammoth = require('mammoth')

async function extractDocxText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer })
  return (value || '').replace(/\s+/g, ' ').trim()
}

function decodePdfString(s) {
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
}

function extractPdfText(buffer) {
  const str = buffer.toString('latin1')
  let text = ''
  const btEt = /BT([\s\S]*?)ET/g
  let m
  while ((m = btEt.exec(str)) !== null) {
    const block = m[1]
    const strRe = /\(([^)\\]*(\\.[^)\\]*)*)\)\s*Tj/g
    const arrRe = /\[([^\]]*)\]\s*TJ/g
    let inner
    while ((inner = strRe.exec(block)) !== null) text += decodePdfString(inner[1]) + ' '
    while ((inner = arrRe.exec(block)) !== null) {
      const parts = inner[1].match(/\(([^)\\]*(\\.[^)\\]*)*)\)/g) || []
      text += parts.map(p => decodePdfString(p.slice(1, -1))).join('') + ' '
    }
  }
  return text.replace(/\s+/g, ' ').trim()
}

// Devuelve el texto del documento según su extensión. '' si no se pudo.
async function extractText(buffer, ext) {
  try {
    const e = String(ext || '').toLowerCase()
    if (e === 'docx' || e === 'doc') return await extractDocxText(buffer)
    if (e === 'pdf') return extractPdfText(buffer)
    if (e === 'txt' || e === 'md') return buffer.toString('utf-8').replace(/\s+/g, ' ').trim()
    return ''
  } catch { return '' }
}

module.exports = { extractText, extractDocxText, extractPdfText }
