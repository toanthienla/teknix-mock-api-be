// src/services/auth.service.js
// Xử lý giao tiếp với DB cho user (dùng trong Auth)

const db = require('../config/db');

async function createUser(email, passwordHash) {
  const q = 'INSERT INTO users(email, password) VALUES($1,$2) RETURNING id, email';
  const { rows } = await db.query(q, [email, passwordHash]);
  return rows[0];
}

async function findUserByEmail(email) {
  const { rows } = await db.query(
    'SELECT * FROM users WHERE email=$1 LIMIT 1',
    [email]
  );
  return rows[0];
}

module.exports = { createUser, findUserByEmail };
