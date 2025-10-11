// services/endpoint_responses_ful.service.js
// Function-based exports + JOIN qua endpoints_ful.origin_id khi cần map từ stateless

const { statefulPool } = require("../config/db");

/**
 * Lấy 1 response theo id (stateful)
 */
async function findById(id) {
  const sql = `SELECT * FROM endpoint_responses_ful WHERE id = $1 LIMIT 1`;
  const { rows } = await statefulPool.query(sql, [id]);
  return rows[0] || null;
}

/**
 * Lấy tất cả responses theo endpoint_id (stateful)
 */
async function findByEndpointId(endpointId) {
  const sql = `
    SELECT * 
    FROM endpoint_responses_ful 
    WHERE endpoint_id = $1
    ORDER BY created_at DESC
  `;
  const { rows } = await statefulPool.query(sql, [endpointId]);
  return rows;
}

/**
 * Xoá 1 response theo id
 */
async function deleteById(id) {
  const sql = `DELETE FROM endpoint_responses_ful WHERE id = $1`;
  const result = await statefulPool.query(sql, [id]);
  return result.rowCount > 0;
}

/**
 * Lấy response MỚI NHẤT theo origin_id (id endpoint bên stateless)
 * JOIN: endpoint_responses_ful.endpoint_id -> endpoints_ful.id -> endpoints_ful.origin_id
 */
async function findLatestByOriginId(originId) {
  const sql = `
    SELECT rf.*
    FROM endpoint_responses_ful rf
    JOIN endpoints_ful ef ON rf.endpoint_id = ef.id
    WHERE ef.origin_id = $1
    ORDER BY rf.created_at DESC
    LIMIT 1
  `;
  const { rows } = await statefulPool.query(sql, [originId]);
  return rows[0] || null;
}

/**
 * (Tuỳ chọn) Lấy TOÀN BỘ responses theo origin_id
 */
async function listByOriginId(originId) {
  const sql = `
    SELECT rf.*
    FROM endpoint_responses_ful rf
    JOIN endpoints_ful ef ON rf.endpoint_id = ef.id
    WHERE ef.origin_id = $1
    ORDER BY rf.created_at DESC
  `;
  const { rows } = await statefulPool.query(sql, [originId]);
  return rows;
}

module.exports = {
  findById,
  findByEndpointId,
  deleteById,
  findLatestByOriginId,
  listByOriginId,
};
