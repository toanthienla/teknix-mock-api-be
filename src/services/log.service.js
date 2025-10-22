//const pool = require("../config/db"); // PostgreSQL connection pool

/**
 * Lưu log request/response vào DB
 * @param {Object} dbPool
 * @param {Object} log
 * @param {number} log.projectId
 * @param {number} [log.endpointId]
 * @param {number} [log.endpointResponseId]
 * @param {string} log.method
 * @param {string} log.path
 * @param {Object} log.headers
 * @param {Object} [log.body]
 * @param {number} log.statusCode
 * @param {Object} [log.responseBody]
 * @param {string} log.ip
 * @param {number} log.latencyMs
 */
async function logRequest(dbPool, log) {
  const query = `
   INSERT INTO project_request_logs (
      project_id, endpoint_id, endpoint_response_id, user_id,
      request_method, request_path, request_headers, request_body,
      response_status_code, response_body, ip_address, latency_ms
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11, $12
    )
    RETURNING id;
  `;
  const values = [log.projectId || null, log.endpointId || null, log.endpointResponseId || null, log.method, log.path, log.headers || {}, log.body || {}, log.statusCode, log.responseBody || {}, log.ip || null, log.latencyMs || 0];
  const { rows } = await dbPool.query(query, values);
  return rows[0].id;
}

module.exports = {
  logRequest,
};
