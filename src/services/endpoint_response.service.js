const db = require('../config/db');

async function getByEndpointId(endpointId) {
  const { rows } = await db.query(
    `SELECT id, endpoint_id, name, status_code, response_body, is_default, created_at, updated_at
     FROM endpoint_responses
     WHERE endpoint_id = $1
     ORDER BY created_at DESC`,
    [endpointId]
  );
  return rows;
}

async function getById(id) {
  const { rows } = await db.query(
    `SELECT id, endpoint_id, name, status_code, response_body, is_default, created_at, updated_at
     FROM endpoint_responses
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function create({ endpoint_id, name, status_code, response_body, is_default }) {
  const { rows } = await db.query(
    `INSERT INTO endpoint_responses (endpoint_id, name, status_code, response_body, is_default)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, endpoint_id, name, status_code, response_body, is_default, created_at, updated_at`,
    [endpoint_id, name, status_code, response_body, is_default]
  );
  return rows[0];
}

async function update(id, { name, status_code, response_body, is_default }) {
  const { rows } = await db.query(
    `UPDATE endpoint_responses
     SET name = COALESCE($1, name),
         status_code = COALESCE($2, status_code),
         response_body = COALESCE($3, response_body),
         is_default = COALESCE($4, is_default),
         updated_at = NOW()
     WHERE id = $5
     RETURNING id, endpoint_id, name, status_code, response_body, is_default, created_at, updated_at`,
    [name, status_code, response_body, is_default, id]
  );
  return rows[0] || null;
}

async function remove(id) {
  await db.query('DELETE FROM endpoint_responses WHERE id = $1', [id]);
  return true;
}

module.exports = {
  getByEndpointId,
  getById,
  create,
  update,
  remove
};
