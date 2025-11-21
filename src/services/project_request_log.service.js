const wsNotify = require("../centrifugo/centrifugo.service");
const { render } = require("../utils/wsTemplate");

// Helper: render đệ quy (đối với message là object/array)
function renderDeep(value, ctx, renderFn) {
  if (value == null) return value;
  if (typeof value === "string") return renderFn(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx, renderFn));
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = renderDeep(value[k], ctx, renderFn);
    return out;
  }
  return value;
}

async function maybePublishWsOnLog(pool, logId, log) {
  // cần có project + endpoint để join config
  if (!log.project_id || !log.endpoint_id) return;

  const headers = log.request_headers || {};
  const ncMeta = headers.__nextcall || null;
  const isNextCall = !!ncMeta?.is_nextcall;

  // 1️⃣ Chọn project để publish
  //  - normal log: publish về chính project của log
  //  - nextCall: cố gắng publish về project của log cha
  let channelProjectId = log.project_id;

  if (isNextCall && ncMeta.parent_log_id) {
    try {
      const parentRes = await pool.query(`SELECT project_id FROM project_request_logs WHERE id = $1 LIMIT 1`, [ncMeta.parent_log_id]);
      const parentPid = parentRes.rows?.[0]?.project_id;
      if (parentPid) {
        channelProjectId = parentPid; // 💡 project của endpoint gốc
      }
    } catch (e) {
      console.error("[logs] maybePublishWsOnLog parent lookup error:", e?.message || e);
    }
  }

  // 2️⃣ Lấy config project + endpoint của CHÍNH endpoint trong log
  const { rows } = await pool.query(
    `
      SELECT
        p.id                 AS project_id,
        p.websocket_enabled  AS ws_project_enabled,
        e.websocket_config   AS ws_config
      FROM projects p
      JOIN endpoints e ON e.id = $2
      WHERE p.id = $1
      LIMIT 1
    `,
    [log.project_id, log.endpoint_id]
  );

  if (!rows.length) return;
  const row = rows[0];

  // project chứa endpoint này có bật WS không?
  if (!row.ws_project_enabled) return;

  const cfg = row.ws_config || {};
  if (!cfg.enabled) return;

  const status = Number(log.response_status_code);
  if (cfg.condition != null) {
    const expect = Number(cfg.condition);
    if (Number.isFinite(expect) && Number.isFinite(status) && status !== expect) {
      return;
    }
  }

  // 3️⃣ Payload: render template nếu có cfg.message, ngược lại dùng default
  let payload;
  if (cfg.message && typeof cfg.message === "object") {
    // cfg.message là object → render từng field
    const ctx = {
      request: {
        method: (log.request_method || "").toUpperCase(),
        path: log.request_path || "",
        headers: log.request_headers || {},
        body: log.request_body || {},
      },
      response: {
        status_code: status,
        body: log.response_body || {},
      },
    };
    payload = renderDeep(cfg.message, ctx, render);
  } else if (cfg.message && typeof cfg.message === "string") {
    // cfg.message là string → render string
    const ctx = {
      request: {
        method: (log.request_method || "").toUpperCase(),
        path: log.request_path || "",
        headers: log.request_headers || {},
        body: log.request_body || {},
      },
      response: {
        status_code: status,
        body: log.response_body || {},
      },
    };
    payload = render(cfg.message, ctx);
  } else {
    // Mặc định: object với thông tin log
    payload = {
      event: "request_log_created",
      project_id: row.project_id,
      endpoint_id: row.endpoint_id,
      log_id: logId,
      status,
    };
  }

  try {
    // 🔥 Normal: publish về project của log
    //    NextCall: publish về project cha (nếu tìm được)
    await wsNotify.publishToProjectChannel(channelProjectId, payload);
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

// Chuẩn hoá request_path: luôn gắn prefix /{workspace_name}/{project_name}
// cho cả stateless và stateful dựa trên project_id.
async function buildFullRequestPath(pool, log) {
  let p = log.request_path;
  if (!p) return p ?? null;
  if (typeof p !== "string") p = String(p);

  p = p.trim();
  if (!p) return null;
  if (!p.startsWith("/")) p = "/" + p;

  // Không có project_id thì đành dùng nguyên path đang có
  if (!log.project_id) {
    return p;
  }

  try {
    const { rows } = await pool.query(
      `SELECT w.name AS workspace_name, p.name AS project_name
         FROM projects p
         JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1
        LIMIT 1`,
      [log.project_id]
    );

    const ws = rows[0]?.workspace_name;
    const pj = rows[0]?.project_name;
    if (!ws || !pj) {
      return p;
    }

    const prefix = `/${ws}/${pj}`;
    const lowerP = p.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();

    // Nếu đã có đúng prefix /ws/pj rồi thì giữ nguyên
    if (lowerP === lowerPrefix || lowerP.startsWith(lowerPrefix + "/")) {
      return p;
    }

    // Ngược lại, ghép prefix vào trước path gốc
    return prefix + p;
  } catch (e) {
    console.error("[logs] buildFullRequestPath failed:", e?.message || e);
    return p;
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
  // 🚫 Nếu không có bất kỳ thông tin project/endpoint nào
  // thì bỏ qua, tránh sinh log rác (như dòng 1709 bạn đang thấy)
  if (log.project_id == null && log.endpoint_id == null && log.stateful_endpoint_id == null) {
    console.log("[logs] skip insertLog: missing project_id/endpoint_id/stateful_endpoint_id", log.request_method, log.request_path);
    return null;
  }

  // Chuẩn hoá request_path về dạng /workspaceName/projectName/path
  const requestPath = await buildFullRequestPath(pool, log);

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
    log.endpoint_response_id ?? null,
    log.stateful_endpoint_id ?? null,
    log.stateful_endpoint_response_id ?? null,
    log.user_id ?? null,
    log.request_method ?? null,
    requestPath ?? null,
    safeStringify(log.request_headers),
    safeStringify(log.request_body),
    Number.isFinite(Number(log.response_status_code)) ? Number(log.response_status_code) : null,
    safeStringify(log.response_body),
    log.ip_address ?? null,
    Number.isFinite(Number(log.latency_ms)) ? Number(log.latency_ms) : null,
  ];
  const { rows } = await pool.query(text, values);

  const id = rows[0]?.id ?? null;

  // 🔔 Sau khi insert xong, xử lý WS CHO NEXTCALL (nhờ guard trong maybePublishWsOnLog)
  if (id) {
    try {
      await maybePublishWsOnLog(pool, id, log);
    } catch (e) {
      console.error("[logs] maybePublishWsOnLog error:", e?.message || e);
    }
  }

  return id;
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
  if (opts.dateFrom) add(`l.created_at >= ?`, new Date(opts.dateFrom));
  if (opts.dateTo) add(`l.created_at <= ?`, new Date(opts.dateTo));

  // New filters for stateful ids
  if (opts.endpointResponseId != null) add(`l.endpoint_response_id = ?`, opts.endpointResponseId);
  if (opts.statefulEndpointId != null) add(`l.stateful_endpoint_id = ?`, opts.statefulEndpointId);
  if (opts.statefulEndpointResponseId != null) add(`l.stateful_endpoint_response_id = ?`, opts.statefulEndpointResponseId);

  // Latency range filter
  if (opts.minLatency != null) add(`l.latency_ms >= ?`, opts.minLatency);
  if (opts.maxLatency != null) add(`l.latency_ms <= ?`, opts.maxLatency);

  // Latency exact value filter (single or multiple)
  if (opts.latencyExact && Array.isArray(opts.latencyExact) && opts.latencyExact.length > 0) {
    const placeholders = opts.latencyExact.map(() => `$${idx++}`).join(",");
    conds.push(`l.latency_ms IN (${placeholders})`);
    params.push(...opts.latencyExact);
  }

  // 🔍 Full-text search trên các cột hiển thị (KHÔNG bao gồm ID fields):
  //    - Method: request_method (ILIKE - substring)
  //    - Status: response_status_code (exact match hoặc bắt đầu bằng)
  //    - Latency: latency_ms (exact match hoặc bắt đầu bằng)
  //    - Response names (stateless + stateful) (ILIKE - substring)
  //    ⚠️ BỎ request_path: tránh match chữ số/ký tự không liên quan trong path
  //    ⚠️ BỎ response_body: không search trong data
  if (opts.search && String(opts.search).trim() !== "") {
    const pattern = `%${String(opts.search).trim()}%`;
    const searchNum = String(opts.search).trim();
    // Regex: match chính xác (^8$) hoặc bắt đầu bằng (^8[0-9]+)
    const numPattern = `^(${searchNum}|${searchNum}[0-9]+)$`;

    conds.push(
      `(
        l.request_method ILIKE $${idx}
        OR CAST(l.response_status_code AS TEXT) ~ $${idx + 1}
        OR CAST(l.latency_ms AS TEXT) ~ $${idx + 2}
        OR er.name ILIKE $${idx + 3}
        OR erf.name ILIKE $${idx + 4}
      )`
    );

    params.push(
      pattern, // method (substring match)
      numPattern, // status (exact or starts with)
      numPattern, // latency (exact or starts with)
      pattern // er.name (substring match)
    );
    idx += 5;
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(500, Number(opts.limit))) : 100;
  const offset = Number.isFinite(Number(opts.offset)) ? Math.max(0, Number(opts.offset)) : 0;

  const sql = `
    SELECT
      l.id,
      l.project_id,
      l.endpoint_id,
      l.endpoint_response_id,
      er.name AS endpoint_response_name,
      l.stateful_endpoint_id,
      l.stateful_endpoint_response_id,
      erf.name AS stateful_endpoint_response_name,
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
    LEFT JOIN endpoint_responses er
      ON er.id = l.endpoint_response_id
    LEFT JOIN endpoint_responses_ful erf
      ON erf.id = l.stateful_endpoint_response_id
    ${where}
    ORDER BY l.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS cnt
    FROM project_request_logs l
    LEFT JOIN endpoint_responses er
      ON er.id = l.endpoint_response_id
    LEFT JOIN endpoint_responses_ful erf
      ON erf.id = l.stateful_endpoint_response_id
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
