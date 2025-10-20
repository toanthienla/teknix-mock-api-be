// src/services/project_request_log.service.js

function safeStringify(obj) {
  try {
    return JSON.stringify(obj ?? {});
  } catch {
    return JSON.stringify({ _error: "unstringifiable" });
  }
}

/**
 * Ghi một bản log.
 * pool: pg Pool DB stateless (req.db.stateless)
 * log: {
 *   project_id, endpoint_id,
 *   endpoint_response_id,                  // STATeless (FK) - nullable
 *   stateful_endpoint_id,                  // STATEful (no FK) - nullable
 *   stateful_endpoint_response_id,         // STATEful (no FK) - nullable
 *   request_method, request_path,
 *   request_headers (object), request_body (object),
 *   response_status_code, response_body (object),
 *   ip_address, latency_ms
 * }
 */
exports.insertLog = async (pool, log) => {
  const text = `
    INSERT INTO project_request_logs
      (project_id, endpoint_id,
       endpoint_response_id, stateful_endpoint_id, stateful_endpoint_response_id,
       request_method, request_path,
       request_headers, request_body,
       response_status_code, response_body,
       ip_address, latency_ms)
    VALUES
      ($1, $2,
       $3, $4, $5,
       $6, $7,
       $8::jsonb, $9::jsonb,
       $10, $11::jsonb,
       $12, $13)
    RETURNING id
  `;
  const values = [
    log.project_id ?? null,
    log.endpoint_id ?? null,

    // Chỉ một trong 2 hướng dùng: stateless hoặc stateful
    log.endpoint_response_id ?? null, // stateless
    log.stateful_endpoint_id ?? null, // stateful (no FK)
    log.stateful_endpoint_response_id ?? null, // stateful (no FK)

    log.request_method ?? null,
    log.request_path ?? null,
    safeStringify(log.request_headers),
    safeStringify(log.request_body),
    Number.isFinite(Number(log.response_status_code)) ? Number(log.response_status_code) : null,
    safeStringify(log.response_body),
    log.ip_address ?? null,
    Number.isFinite(Number(log.latency_ms)) ? Number(log.latency_ms) : null,
  ];
  const { rows } = await pool.query(text, values);
  return rows[0]?.id ?? null;
};

/**
 * Lấy danh sách logs (filter + phân trang)
 * opts: {
 *   projectId, endpointId, statusCode, method, dateFrom, dateTo,
 *   endpointResponseId, statefulEndpointId, statefulEndpointResponseId,
 *   limit, offset
 * }
 */
exports.listLogs = async (pool, opts = {}) => {
  const conds = [];
  const params = [];
  let idx = 1;

  const add = (sql, v) => {
    conds.push(sql.replace("?", `$${idx++}`));
    params.push(v);
  };

  if (opts.projectId != null) add(`l.project_id = ?`, opts.projectId);
  if (opts.endpointId != null) add(`l.endpoint_id = ?`, opts.endpointId);
  if (opts.statusCode != null) add(`l.response_status_code = ?`, opts.statusCode);
  if (opts.method) add(`UPPER(l.request_method) = ?`, String(opts.method).toUpperCase());
  if (opts.dateFrom) add(`l.created_at >= ?`, opts.dateFrom);
  if (opts.dateTo) add(`l.created_at <= ?`, opts.dateTo);

  // New filters for stateful ids
  if (opts.endpointResponseId != null) add(`l.endpoint_response_id = ?`, opts.endpointResponseId);
  if (opts.statefulEndpointId != null) add(`l.stateful_endpoint_id = ?`, opts.statefulEndpointId);
  if (opts.statefulEndpointResponseId != null) add(`l.stateful_endpoint_response_id = ?`, opts.statefulEndpointResponseId);

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(500, Number(opts.limit))) : 100;
  const offset = Number.isFinite(Number(opts.offset)) ? Math.max(0, Number(opts.offset)) : 0;

  const sql = `
    SELECT
      l.id,
      l.project_id,
      l.endpoint_id,
      l.endpoint_response_id,
      l.stateful_endpoint_id,
      l.stateful_endpoint_response_id,
      l.request_method,
      l.request_path,
      l.request_headers,
      l.request_body,
      l.response_status_code,
      l.response_body,
      l.ip_address,
      l.latency_ms,
      l.created_at
    FROM project_request_logs l
    ${where}
    ORDER BY l.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const countSql = `
    SELECT COUNT(*)::int AS cnt
    FROM project_request_logs l
    ${where}
  `;

  const [{ rows }, countRes] = await Promise.all([pool.query(sql, params), pool.query(countSql, params)]);

  return {
    count: countRes.rows?.[0]?.cnt ?? 0,
    items: rows || [],
  };
};

exports.getLogById = async (pool, id) => {
  const { rows } = await pool.query(
    `
      SELECT
        l.id,
        l.project_id,
        l.endpoint_id,
        l.endpoint_response_id,
        l.stateful_endpoint_id,
        l.stateful_endpoint_response_id,
        l.request_method,
        l.request_path,
        l.request_headers,
        l.request_body,
        l.response_status_code,
        l.response_body,
        l.ip_address,
        l.latency_ms,
        l.created_at
      FROM project_request_logs l
      WHERE l.id = $1
      LIMIT 1
    `,
    [id]
  );
  return rows[0] || null;
};
