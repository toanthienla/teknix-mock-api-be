//const db = require('../config/db');

// Hàm stringify an toàn: tránh lỗi vòng tham chiếu/BigInt khi convert sang JSON cho cột JSONB
function safeStringify(value) {
  try {
    return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (e) {
    // Fallback: wrap as string message
    return JSON.stringify({ __non_serializable__: true, message: e?.message || String(e) });
  }
}

// Service thao tác bảng project_request_logs
// Cột theo schema:
// id, folder_id,, endpoint_id, endpoint_response_id (có thể NULL),
// request_method, request_path, request_headers (jsonb), request_body (jsonb),
// response_status_code, response_body (jsonb), ip_address, latency_ms, created_at

async function insertLog(dbPool, payload) {
  const {
    folder_id,
    endpoint_id,
    endpoint_response_id = null,
    request_method,
    request_path,
    request_headers = {},
    request_body = {},
    response_status_code,
    response_body = {},
    ip_address,
    latency_ms = null,
  } = payload;

  // Ghi 1 dòng log request/response thực tế
  // Lưu ý: các cột JSONB dùng $param::jsonb nên tham số phải là CHUỖI JSON HỢP LỆ
  const { rows } = await dbPool.query(
    `INSERT INTO project_request_logs (
      folder_id, endpoint_id, endpoint_response_id,
      request_method, request_path, request_headers, request_body,
      response_status_code, response_body, ip_address, latency_ms
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6::jsonb, $7::jsonb,
      $8, $9::jsonb, $10, $11
    ) RETURNING *`,
    [
      folder_id,
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

  return { clearedEndpoint: r1.rowCount || 0, clearedResponses: r2.rowCount || 0 };
}

// NULL hoá toàn bộ tham chiếu thuộc một workspace: folder_id,, endpoint_id, endpoint_response_id
// Mục tiêu: xoá workspace mà không đụng schema, vẫn giữ dữ liệu log lịch sử
async function nullifyWorkspaceTree(dbPool, workspaceId) {
  const wid = Number(workspaceId);
  if (!Number.isInteger(wid)) return { clearedProjects: 0, clearedEndpoints: 0, clearedResponses: 0 };

  // 1) Bỏ tham chiếu folder_id, của các project thuộc workspace
  const p = await dbPool.query(
    `UPDATE project_request_logs
     SET folder_id, = NULL
     WHERE project_id IN (
       SELECT p.id FROM projects p WHERE p.workspace_id = $1
     )`,
    [wid]
  );

  // 2) Bỏ tham chiếu endpoint_id của các endpoint thuộc các project trong workspace
  const e = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_id = NULL
     WHERE endpoint_id IN (
       SELECT e.id FROM endpoints e
       JOIN projects p ON p.id = e.project_id
       WHERE p.workspace_id = $1
     )`,
    [wid]
  );

  // 3) Bỏ tham chiếu endpoint_response_id của các response thuộc các endpoint trong workspace
  const r = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_response_id = NULL
     WHERE endpoint_response_id IN (
       SELECT er.id FROM endpoint_responses er
       JOIN endpoints e ON e.id = er.endpoint_id
       JOIN projects p ON p.id = e.project_id
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

// NULL hoá toàn bộ tham chiếu thuộc một project: project_id, endpoint_id, endpoint_response_id
// Dùng khi xoá project để không vi phạm FK và VẪN GIỮ dữ liệu log
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

  // 2) Bỏ tham chiếu endpoint_id của các endpoint thuộc project này
  const e = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_id = NULL
     WHERE endpoint_id IN (
       SELECT e.id FROM endpoints e WHERE e.project_id = $1
     )`,
    [pid]
  );

  // 3) Bỏ tham chiếu endpoint_response_id của các response thuộc các endpoint của project này
  const r = await dbPool.query(
    `UPDATE project_request_logs
     SET endpoint_response_id = NULL
     WHERE endpoint_response_id IN (
       SELECT er.id FROM endpoint_responses er
       JOIN endpoints e ON e.id = er.endpoint_id
       WHERE e.project_id = $1
     )`,
    [pid]
  );

  return {
    clearedProject: p.rowCount || 0,
    clearedEndpoints: e.rowCount || 0,
    clearedResponses: r.rowCount || 0,
  };
}

// Lấy danh sách log theo filter (bắt buộc project_id; còn lại tùy chọn)
async function listLogs(dbPool, { folder_id, endpoint_id, method, path, status_code, from, to, limit = 100, offset = 0 }) {
  const conds = ['folder_id = $1'];
  const params = [folder_id];
  let idx = params.length;

  if (endpoint_id) { idx += 1; conds.push(`endpoint_id = $${idx}`); params.push(endpoint_id); }
  if (method) { idx += 1; conds.push(`UPPER(request_method) = UPPER($${idx})`); params.push(method); }
  if (path) { idx += 1; conds.push(`request_path ILIKE $${idx}`); params.push(`%${path}%`); }
  if (status_code) { idx += 1; conds.push(`response_status_code = $${idx}`); params.push(status_code); }
  if (from) { idx += 1; conds.push(`created_at >= $${idx}`); params.push(from); }
  if (to) { idx += 1; conds.push(`created_at <= $${idx}`); params.push(to); }

  idx += 1; params.push(limit);
  idx += 1; params.push(offset);

  const { rows } = await dbPool.query(
    `SELECT * FROM project_request_logs
     WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${idx - 1} OFFSET $${idx}`,
    params
  );
  return rows;
}

async function getLogById(dbPool, id) {
  // Lấy chi tiết 1 log theo id
  const { rows } = await dbPool.query('SELECT * FROM project_request_logs WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = {
  insertLog,
  nullifyEndpointResponseRef,
  nullifyEndpointAndResponses,
  nullifyWorkspaceTree,
  nullifyProjectTree,
  listLogs,
  getLogById,
};
