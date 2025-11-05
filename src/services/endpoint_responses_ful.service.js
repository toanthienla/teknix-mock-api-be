// services/endpoint_responses_ful.service.js
// Function-based exports (schema mới: endpoints_ful.endpoint_id → endpoints.id)
const { statelessPool } = require("../config/db");

/**
 * Lấy 1 response theo id (stateful)
 */
async function findById(id) {
  const sql = `
    SELECT id, endpoint_id, name, status_code, response_body, delay_ms,
           
           created_at, updated_at
      FROM endpoint_responses_ful
     WHERE id = $1
     LIMIT 1`;
  const { rows } = await statelessPool.query(sql, [id]);
  return rows[0] || null;
}

/**
 * Lấy tất cả responses theo endpoint_id (stateful)
 */
async function findByEndpointId(endpointId) {
  // endpointId ở đây là ID của bản ghi trong endpoints_ful (stateful meta),
  // KHÔNG phải endpoints.id của stateless gốc.
  const sql = `
    SELECT id, endpoint_id, name, status_code, response_body, delay_ms,
            
           created_at, updated_at
      FROM endpoint_responses_ful
     WHERE endpoint_id = $1
     ORDER BY id ASC`;
  const { rows } = await statelessPool.query(sql, [endpointId]);
  return rows;
}
/**
 * Cập nhật 1 response theo id
 */
async function updateById(id, patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    fields.push(`name = $${i++}`);
    vals.push(patch.name?.trim() ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "response_body")) {
    fields.push(`response_body = $${i++}::jsonb`);
    vals.push(JSON.stringify(patch.response_body ?? {}));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "delay_ms")) {
    fields.push(`delay_ms = $${i++}`);
    vals.push(Number(patch.delay_ms) || 0);
  }
  if (!fields.length) return null;
  vals.push(id);
  const { rows } = await statelessPool.query(
    `UPDATE endpoint_responses_ful
        SET ${fields.join(", ")}, updated_at = NOW()
      WHERE id = $${i}
      RETURNING id, endpoint_id, name, status_code, response_body, delay_ms,
                 
                created_at, updated_at`,
    vals
  );
  return rows[0] || null;
}

/**
 * Xoá 1 response theo id
 */
async function deleteById(id) {
  // Nullify trong project_request_logs trước khi xoá
  await statelessPool.query(
    `UPDATE project_request_logs
        SET stateful_endpoint_response_id = NULL
      WHERE stateful_endpoint_response_id = $1`,
    [id]
  );
  const sql = `DELETE FROM endpoint_responses_ful WHERE id = $1`;
  const result = await statelessPool.query(sql, [id]);
  return result.rowCount > 0;
}

// (Tuỳ chọn cũ theo origin_id – nếu cần, map qua endpoint_id)
async function findLatestByOriginId(originId) {
  const { rows: map } = await statelessPool.query(`SELECT id FROM endpoints_ful WHERE endpoint_id = $1 LIMIT 1`, [originId]);
  if (map.length === 0) return null;
  const { rows } = await statelessPool.query(
    `SELECT rf.*
       FROM endpoint_responses_ful rf
      WHERE rf.endpoint_id = $1
      ORDER BY rf.created_at DESC
      LIMIT 1`,
    [map[0].id]
  );
  return rows[0] || null;
}
async function listByOriginId(originId) {
  const { rows: map } = await statelessPool.query(`SELECT id FROM endpoints_ful WHERE endpoint_id = $1 LIMIT 1`, [originId]);
  if (map.length === 0) return [];
  const { rows } = await statelessPool.query(
    `SELECT rf.*
       FROM endpoint_responses_ful rf
      WHERE rf.endpoint_id = $1
      ORDER BY rf.created_at DESC`,
    [map[0].id]
  );
  return rows;
}

module.exports = {
  findById,
  findByEndpointId,
  updateById,
  deleteById,
  findLatestByOriginId,
  listByOriginId,
};
