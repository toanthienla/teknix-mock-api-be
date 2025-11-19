// src/services/project_request_log.service.js

// giả sử bạn có service publish WS
const wsNotify = require("../centrifugo/centrifugo.service"); // đặt tên cho đúng với project của bạn

async function maybePublishWsOnLog(pool, logId, log) {
  // cần có cả project_id + endpoint_id để join
  if (!log.project_id || !log.endpoint_id) return;

  // 1) Lấy thông tin project + endpoint + websocket_config
  const { rows } = await pool.query(
    `
      SELECT
        p.id                AS project_id,
        p.ws_global_enabled AS ws_project_enabled,   -- ⚠️ sửa tên cột đúng với DB của bạn
        e.websocket_config  AS ws_config             -- jsonb: { enabled, condition, message }
      FROM projects p
      JOIN endpoints e ON e.id = $2
      WHERE p.id = $1
      LIMIT 1
    `,
    [log.project_id, log.endpoint_id]
  );

  if (!rows.length) return;
  const row = rows[0];

  // 2) Công tắc tổng project
  if (!row.ws_project_enabled) {
    return;
  }

  const cfg = row.ws_config || {};
  if (!cfg.enabled) {
    return;
  }

  // 3) Check điều kiện status nếu có
  const status = Number(log.response_status_code);
  if (cfg.condition != null) {
    const expect = Number(cfg.condition);
    if (Number.isFinite(expect) && Number.isFinite(status) && status !== expect) {
      return;
    }
  }

  // 4) Payload gửi ra WS:
  const payload =
    cfg.message && typeof cfg.message === "object"
      ? { ...cfg.message, log_id: logId, status } // có thể merge thêm log_id/status
      : {
          event: "request_log_created",
          project_id: row.project_id,
          endpoint_id: log.endpoint_id,
          log_id: logId,
          status,
        };

  try {
    await wsNotify.publishToProjectChannel(row.project_id, payload);
  } catch (e) {
    console.error("[logs] WS publish failed:", e?.message || e);
  }
}

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
       user_id,
       request_method, request_path,
       request_headers, request_body,
       response_status_code, response_body,
       ip_address, latency_ms)
    VALUES
      ($1, $2,
       $3, $4, $5,
       $6,
       $7, $8,
       $9::jsonb, $10::jsonb,
       $11, $12::jsonb,
       $13, $14)
    RETURNING id
  `;
  const values = [
    log.project_id ?? null,
    log.endpoint_id ?? null,

    // Chỉ một trong 2 hướng dùng: stateless hoặc stateful
    log.endpoint_response_id ?? null, // stateless
    log.stateful_endpoint_id ?? null, // stateful (no FK)
    log.stateful_endpoint_response_id ?? null, // stateful (no FK)
    log.user_id ?? null,
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

exports.getLogsByProjectId = async (pool, projectId, limit, offset) => {
  projectId = Number(projectId);
  limit = Number(limit) || 10;
  offset = Number(offset) || 0;

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
      l.created_at,
      COUNT(*) OVER() as total_count
    FROM project_request_logs l
    WHERE l.project_id = $1
    ORDER BY l.created_at DESC
    LIMIT $2 OFFSET $3
  `;

  console.log("[DBG] service.getLogsByProjectId - sql params:", { projectId, limit, offset });
  const { rows } = await pool.query(sql, [projectId, limit, offset]);

  // If rows empty, still need total: run COUNT separately (safe fallback)
  let total = 0;
  if (rows.length > 0) {
    total = Number(rows[0].total_count) || 0;
    // remove total_count from each item before returning (optional)
    const items = rows.map((r) => {
      const { total_count, ...rest } = r;
      return rest;
    });
    return { items, total };
  } else {
    // fallback: no rows returned, count directly
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM project_request_logs WHERE project_id = $1`, [projectId]);
    total = parseInt(countRes.rows[0]?.total || "0", 10);
    return { items: [], total };
  }
};

exports.nullifyFolderTree = async (client, folderId) => {
  // Lấy danh sách endpoint trong folder này
  const { rows: endpoints } = await client.query(`SELECT id FROM endpoints WHERE folder_id = $1`, [folderId]);

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

  // 🔄 Nullify notifications liên quan các endpoint trong folder
  await client.query(
    `UPDATE notifications
       SET project_request_log_id = NULL,
           endpoint_id            = NULL,
           user_id                = NULL
     WHERE endpoint_id = ANY($1)`,
    [endpointIds]
  );

  console.log(`🧹 Đã nullify logs cho folder ${folderId} (liên quan ${endpointIds.length} endpoint).`);
};

exports.nullifyWorkspaceTree = async (client, workspaceId) => {
  // Lấy tất cả project trong workspace
  const { rows: projects } = await client.query(`SELECT id FROM projects WHERE workspace_id = $1`, [workspaceId]);

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
  const { rows: folders } = await client.query(`SELECT id FROM folders WHERE project_id = $1`, [projectId]);

  if (folders.length === 0) {
    console.log(`🟡 Project ${projectId} không có folder nào.`);
    return;
  }

  for (const f of folders) {
    await exports.nullifyFolderTree(client, f.id);
  }

  // Ngoài ra, nullify trực tiếp các endpoint không thuộc folder nào (nếu có)
  const { rows: endpointsNoFolder } = await client.query(`SELECT id FROM endpoints WHERE project_id = $1 AND folder_id IS NULL`, [projectId]);
  if (endpointsNoFolder.length > 0) {
    const endpointIds = endpointsNoFolder.map((e) => e.id);
    await client.query(
      `UPDATE project_request_logs
       SET endpoint_id = NULL, endpoint_response_id = NULL
       WHERE endpoint_id = ANY($1)`,
      [endpointIds]
    );
    await client.query(
      `UPDATE notifications
         SET project_request_log_id = NULL,
             endpoint_id            = NULL,
             user_id                = NULL
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
  +(await client.query(
    `UPDATE notifications
       SET project_request_log_id = NULL,
           endpoint_id            = NULL,
           user_id                = NULL
     WHERE endpoint_id = $1`,
    [endpointId]
  ));
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
    const { rowCount } = await client.query(`DELETE FROM endpoint_responses WHERE endpoint_id = $1`, [endpointId]);

    console.log(`🧹 Đã nullify logs và xóa ${rowCount} endpoint_responses cho endpoint ${endpointId}`);
  } catch (err) {
    console.error(`❌ Lỗi khi xóa endpoint_responses cho endpoint ${endpointId}:`, err);
    throw err;
  }
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
