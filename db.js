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

module.exports = pool
