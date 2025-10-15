//const db = require('../config/db');

// Hàm stringify an toàn: tránh lỗi vòng tham chiếu/BigInt khi convert sang JSON cho cột JSONB
function safeStringify(value) {
  try {
    return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch (e) {
    // Fallback: wrap as string message
    return JSON.stringify({
      __non_serializable__: true,
      message: e?.message || String(e),
    });
  }
}

// Service thao tác bảng project_request_logs
// Cột theo schema:
// id, folder_id,, endpoint_id, endpoint_response_id (có thể NULL),
// request_method, request_path, request_headers (jsonb), request_body (jsonb),
// response_status_code, response_body (jsonb), ip_address, latency_ms, created_at

async function insertLog(dbPool, payload) {
  const { project_id, endpoint_id, endpoint_response_id = null, request_method, request_path, request_headers = {}, request_body = {}, response_status_code, response_body = {}, ip_address, latency_ms = null } = payload;

  // Ghi 1 dòng log request/response thực tế
  const { rows } = await dbPool.query(
    `INSERT INTO project_request_logs (
       project_id, endpoint_id, endpoint_response_id,
      request_method, request_path, request_headers, request_body,
      response_status_code, response_body, ip_address, latency_ms
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6::jsonb, $7::jsonb,
      $8, $9::jsonb, $10, $11
    ) RETURNING *`,
    [
      project_id,
      endpoint_id,
      endpoint_response_id,
      request_method ?? null,
      request_path ?? null,
      // JSONB fields must be valid JSON strings when using ::jsonb casts
      safeStringify(request_headers ?? {}),
      safeStringify(request_body ?? {}),
      response_status_code,
      safeStringify(response_body ?? {}),
      ip_address ?? null,
      latency_ms,
    ]
  );
  return rows[0];
}

// NULL hoá tham chiếu endpoint_response_id trong project_request_logs trước khi xoá 1 endpoint_response
async function nullifyEndpointResponseRef(dbPool, endpointResponseId) {
  const rid = Number(endpointResponseId);
  if (!Number.isInteger(rid)) return { rowCount: 0 };
  const result = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_response_id = NULL
     WHERE endpoint_response_id = $1`,
    [rid]
  );
  return { rowCount: result.rowCount || 0 };
}

// NULL hoá tham chiếu endpoint_id và toàn bộ endpoint_response_id thuộc 1 endpoint (để có thể xoá endpoint mà vẫn giữ log)
async function nullifyEndpointAndResponses(dbPool, endpointId) {
  const eid = Number(endpointId);
  if (!Number.isInteger(eid)) return { clearedEndpoint: 0, clearedResponses: 0 };

  // 1) Bỏ tham chiếu endpoint_id
  const r1 = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_id = NULL
     WHERE endpoint_id = $1`,
    [eid]
  );

  // 2) Bỏ tham chiếu endpoint_response_id của các response thuộc endpoint này
  const r2 = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_response_id = NULL
     WHERE endpoint_response_id IN (
       SELECT er.id FROM endpoint_responses er WHERE er.endpoint_id = $1
     )`,
    [eid]
  );

  return {
    clearedEndpoint: r1.rowCount || 0,
    clearedResponses: r2.rowCount || 0,
  };
}

// NULL hoá toàn bộ tham chiếu thuộc một workspace: folder_id,, endpoint_id, endpoint_response_id
// Mục tiêu: xoá workspace mà không đụng schema, vẫn giữ dữ liệu log lịch sử
// project_request_log.service.js (sửa nullifyWorkspaceTree)
// ✅ SỬA: nullify toàn bộ tham chiếu theo workspace (qua folders → projects)
async function nullifyWorkspaceTree(dbPool, workspaceId) {
  const wid = Number(workspaceId);
  if (!Number.isInteger(wid)) return { clearedProjects: 0, clearedEndpoints: 0, clearedResponses: 0 };

  // 1) Bỏ tham chiếu project_id
  const p = await dbPool.query(
    `UPDATE project_request_logs
     SET project_id = NULL
     WHERE project_id IN (
       SELECT p.id FROM projects p WHERE p.workspace_id = $1
     )`,
    [wid]
  );

  // 2) Bỏ tham chiếu endpoint_id (endpoints -> folders -> projects -> workspace)
  const e = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_id = NULL
     WHERE endpoint_id IN (
       SELECT e.id
       FROM endpoints e
       JOIN folders f ON f.id = e.folder_id
       JOIN projects p ON p.id = f.project_id
       WHERE p.workspace_id = $1
     )`,
    [wid]
  );

  // 3) Bỏ tham chiếu endpoint_response_id (đi qua cùng chuỗi join)
  const r = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_response_id = NULL
     WHERE endpoint_response_id IN (
       SELECT er.id
       FROM endpoint_responses er
       JOIN endpoints e ON e.id = er.endpoint_id
       JOIN folders f ON f.id = e.folder_id
       JOIN projects p ON p.id = f.project_id
       WHERE p.workspace_id = $1
     )`,
    [wid]
  );

  return {
    clearedProjects: p.rowCount || 0,
    clearedEndpoints: e.rowCount || 0,
    clearedResponses: r.rowCount || 0,
  };
}

// ✅ SỬA: nullify toàn bộ tham chiếu theo project
async function nullifyProjectTree(dbPool, projectId) {
  const pid = Number(projectId);
  if (!Number.isInteger(pid)) return { clearedProject: 0, clearedEndpoints: 0, clearedResponses: 0 };

  // 1) Bỏ tham chiếu project_id
  const p = await dbPool.query(
    `UPDATE project_request_logs
     SET project_id = NULL
     WHERE project_id = $1`,
    [pid]
  );

  // 2) Bỏ tham chiếu endpoint_id (endpoints -> folders(project_id))
  const e = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_id = NULL
     WHERE endpoint_id IN (
       SELECT e.id
       FROM endpoints e
       JOIN folders f ON f.id = e.folder_id
       WHERE f.project_id = $1
     )`,
    [pid]
  );

  // 3) Bỏ tham chiếu endpoint_response_id theo project
  const r = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_response_id = NULL
     WHERE endpoint_response_id IN (
       SELECT er.id
       FROM endpoint_responses er
       JOIN endpoints e ON e.id = er.endpoint_id
       JOIN folders f ON f.id = e.folder_id
       WHERE f.project_id = $1
     )`,
    [pid]
  );

  return {
    clearedProject: p.rowCount || 0,
    clearedEndpoints: e.rowCount || 0,
    clearedResponses: r.rowCount || 0,
  };
}

// ✅ MỚI: nullify theo folder (để xoá folder không vướng FK)
async function nullifyFolderTree(dbPool, folderId) {
  const fid = Number(folderId);
  if (!Number.isInteger(fid)) return { clearedEndpoints: 0, clearedResponses: 0 };

  // Bỏ tham chiếu endpoint_id cho toàn bộ endpoint trong folder
  const e = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_id = NULL
     WHERE endpoint_id IN (
       SELECT e.id FROM endpoints e WHERE e.folder_id = $1
     )`,
    [fid]
  );

  // Bỏ tham chiếu endpoint_response_id cho các response thuộc các endpoint trong folder
  const r = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_response_id = NULL
     WHERE endpoint_response_id IN (
       SELECT er.id
       FROM endpoint_responses er
       JOIN endpoints e ON e.id = er.endpoint_id
       WHERE e.folder_id = $1
     )`,
    [fid]
  );

  return {
    clearedEndpoints: e.rowCount || 0,
    clearedResponses: r.rowCount || 0,
  };
}

// Lấy danh sách log theo filter (bắt buộc project_id; còn lại tùy chọn)
async function listLogs(dbPool, { project_id, folder_id, endpoint_id, method, path, status_code, from, to, limit = 100, offset = 0 }) {
  // Khởi tạo query và các mảng điều kiện, tham số
  let query = "SELECT l.* FROM project_request_logs l";
  const conds = [];
  const params = [];
  let idx = 0;

  // Nếu có project_id, chúng ta cần JOIN với bảng folders
  if (project_id) {
    idx += 1;
    conds.push(`project_id = $${idx}`);
    params.push(project_id);
  } else {
    // Nếu không có project_id, trả về mảng rỗng hoặc ném lỗi
    // tùy theo yêu cầu nghiệp vụ. Ở đây ta trả về mảng rỗng.
    return [];
  }

  // Thêm các điều kiện lọc khác một cách linh hoạt
  if (endpoint_id) {
    idx += 1;
    conds.push(`l.endpoint_id = $${idx}`);
    params.push(endpoint_id);
  }
  if (method) {
    idx += 1;
    conds.push(`UPPER(l.request_method) = UPPER($${idx})`);
    params.push(method);
  }
  if (path) {
    idx += 1;
    conds.push(`l.request_path ILIKE $${idx}`);
    params.push(`%${path}%`);
  }
  if (status_code) {
    idx += 1;
    conds.push(`l.response_status_code = $${idx}`);
    params.push(status_code);
  }
  if (from) {
    idx += 1;
    conds.push(`l.created_at >= $${idx}`);
    params.push(from);
  }
  if (to) {
    idx += 1;
    conds.push(`l.created_at <= $${idx}`);
    params.push(to);
  }

  // Gắn các điều kiện vào câu query chính
  if (conds.length > 0) {
    query += ` WHERE ${conds.join(" AND ")}`;
  }

  // Thêm ORDER BY, LIMIT, OFFSET
  query += ` ORDER BY l.created_at DESC`;

  idx += 1;
  params.push(limit);
  query += ` LIMIT $${idx}`;

  idx += 1;
  params.push(offset);
  query += ` OFFSET $${idx}`;

  const { rows } = await dbPool.query(query, params);
  return rows;
}

async function getLogById(dbPool, id) {
  // Lấy chi tiết 1 log theo id
  const { rows } = await dbPool.query("SELECT * FROM project_request_logs WHERE id = $1", [id]);
  return rows[0] || null;
}

module.exports = {
  insertLog,
  nullifyEndpointResponseRef,
  nullifyEndpointAndResponses,
  nullifyWorkspaceTree,
  nullifyProjectTree,
  nullifyFolderTree,
  listLogs,
  getLogById,
};
