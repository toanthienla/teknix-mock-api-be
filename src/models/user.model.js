const bcrypt = require('bcrypt');

// ===== CREATE USER =====
async function createUser(db, username, password) {
  const hashedPassword = await bcrypt.hash(password, 10);
  const result = await db.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at`,
    [username, hashedPassword]
  );
  return result.rows[0];
}

// ===== FIND USER BY USERNAME =====
async function findUserByUsername(db, username) {
  const result = await db.query(`SELECT * FROM users WHERE username = $1`, [username]);
  return result.rows[0];
}

// ===== CHECK PASSWORD =====
async function checkPassword(password, hashedPassword) {
  return bcrypt.compare(password, hashedPassword);
}

module.exports = {
  createUser,
  findUserByUsername,
  checkPassword,
};
