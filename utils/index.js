'use strict'

const uid    = () => Math.random().toString(36).slice(2, 10)
const parseJ = (v, def) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? def) } catch { return def } }

module.exports = { uid, parseJ }
