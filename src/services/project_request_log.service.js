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

exports.nullifyFolderTree = async (client, folderId) => {
  // Lấy danh sách endpoint trong folder này
  const { rows: endpoints } = await client.query(
    `SELECT id FROM endpoints WHERE folder_id = $1`,
    [folderId]
  );

  if (endpoints.length === 0) {
    console.log(`🟡 Folder ${folderId} không có endpoint nào, bỏ qua nullify logs.`);
    return;
  }

  const endpointIds = endpoints.map((e) => e.id);

  // Xóa tham chiếu endpoint_id khỏi logs
  await client.query(
    `UPDATE project_request_logs
     SET endpoint_id = NULL, endpoint_response_id = NULL
     WHERE endpoint_id = ANY($1)`,
    [endpointIds]
  );

  console.log(`🧹 Đã nullify logs cho folder ${folderId} (liên quan ${endpointIds.length} endpoint).`);
};

exports.nullifyWorkspaceTree = async (client, workspaceId) => {
  // Lấy tất cả project trong workspace
  const { rows: projects } = await client.query(
    `SELECT id FROM projects WHERE workspace_id = $1`,
    [workspaceId]
  );

  if (projects.length === 0) {
    console.log(`🟡 Workspace ${workspaceId} không có project nào.`);
    return;
  }

  for (const p of projects) {
    await exports.nullifyProjectTree(client, p.id);
  }

  console.log(`🧹 Đã nullify logs cho toàn bộ workspace ${workspaceId}`);
};


exports.nullifyProjectTree = async (client, projectId) => {
  // Lấy tất cả folder trong project
  const { rows: folders } = await client.query(
    `SELECT id FROM folders WHERE project_id = $1`,
    [projectId]
  );

  if (folders.length === 0) {
    console.log(`🟡 Project ${projectId} không có folder nào.`);
    return;
  }

  for (const f of folders) {
    await exports.nullifyFolderTree(client, f.id);
  }

  // Ngoài ra, nullify trực tiếp các endpoint không thuộc folder nào (nếu có)
  const { rows: endpointsNoFolder } = await client.query(
    `SELECT id FROM endpoints WHERE project_id = $1 AND folder_id IS NULL`,
    [projectId]
  );
  if (endpointsNoFolder.length > 0) {
    const endpointIds = endpointsNoFolder.map(e => e.id);
    await client.query(
      `UPDATE project_request_logs
       SET endpoint_id = NULL, endpoint_response_id = NULL
       WHERE endpoint_id = ANY($1)`,
      [endpointIds]
    );
  }

  console.log(`🧹 Đã nullify logs cho project ${projectId}`);
};

exports.nullifyEndpointTree = async (client, endpointId) => {
  await client.query(
    `UPDATE project_request_logs
     SET endpoint_id = NULL, endpoint_response_id = NULL
     WHERE endpoint_id = $1`,
    [endpointId]
  );
  console.log(`🧹 Đã nullify logs cho endpoint ${endpointId}`);
};

exports.nullifyEndpointAndResponses = async (client, endpointId) => {
  try {
    // 1️⃣ Nullify logs liên quan đến endpoint
    await client.query(
      `UPDATE project_request_logs
       SET endpoint_id = NULL, endpoint_response_id = NULL
       WHERE endpoint_id = $1`,
      [endpointId]
    );

    // 2️⃣ Xóa toàn bộ response của endpoint này
    const { rowCount } = await client.query(
      `DELETE FROM endpoint_responses WHERE endpoint_id = $1`,
      [endpointId]
    );

    console.log(
      `🧹 Đã nullify logs và xóa ${rowCount} endpoint_responses cho endpoint ${endpointId}`
    );
  } catch (err) {
    console.error(`❌ Lỗi khi xóa endpoint_responses cho endpoint ${endpointId}:`, err);
    throw err;
  }
};