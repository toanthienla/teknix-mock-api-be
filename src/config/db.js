const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '190804',
  database: process.env.DB_NAME || 'teknix_mock_api',
});

module.exports = {
  query: (text, params) => pool.query(text, params)
};
