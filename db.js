const mysql = require('mysql2/promise')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const pool = mysql.createPool({
  host:             process.env.DB_HOST || 'localhost',
  port:             parseInt(process.env.DB_PORT || '3306'),
  user:             process.env.DB_USER || 'root',
  password:         process.env.DB_PASS || '',
  database:         process.env.DB_NAME || 'avi_platform',
  waitForConnections: true,
  connectionLimit:  10,
  timezone:         '+00:00',
})

// Sube el sort_buffer_size POR SESIÓN en cada conexión nueva del pool. El valor por
// defecto de MySQL (256 KB) es insuficiente para ordenar filas con columnas JSON/TEXT
// (conversaciones, mensajes…) y dispara el error "Out of sort memory, consider
// increasing server sort buffer size", que congela la interacción. Es a nivel de
// SESIÓN (no requiere privilegios) y acotado: connectionLimit(10) × este valor.
const SORT_BUFFER = parseInt(process.env.DB_SORT_BUFFER_BYTES || '', 10) || 8 * 1024 * 1024 // 8 MB
const corePool = pool.pool || pool
if (corePool && typeof corePool.on === 'function') {
  corePool.on('connection', (conn) => {
    try {
      conn.query(`SET SESSION sort_buffer_size = ${SORT_BUFFER}`, (err) => {
        if (err) console.warn('[db] no se pudo ajustar sort_buffer_size:', err.message)
      })
    } catch (e) { console.warn('[db] sort_buffer_size:', e.message) }
  })
}

module.exports = pool
