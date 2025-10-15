const svc = require("../services/project_request_log.service");
const { success, error } = require("../utils/response");

// API: Liệt kê logs theo project và filter (phục vụ audit/analytics)
// GET /project_request_logs?project_id=..&endpoint_id=..&method=GET&path=/users&status_code=200&from=...&to=...&limit=50&offset=0
async function list(req, res) {
  try {
    const { project_id, endpoint_id, method, path, status_code, from, to, limit, offset } = req.query;

    // Yêu cầu người dùng cung cấp ít nhất project_id hoặc folder_id
    if (!project_id) {
      return error(res, 400, "Cần cung cấp query parameter project_id");
    }

    const filters = {
      project_id: project_id ? parseInt(project_id, 10) : undefined,
      endpoint_id: endpoint_id ? parseInt(endpoint_id, 10) : undefined,
      method,
      path,
      status_code: status_code ? parseInt(status_code, 10) : undefined,
      from,
      to,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    };

    // Gọi service để truy vấn theo bộ lọc
    const rows = await svc.listLogs(req.db.stateless, filters);
    return success(res, rows);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// API: Lấy chi tiết 1 log
// GET /project_request_logs/:id
async function getById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return error(res, 400, "id phải là số nguyên");
    const row = await svc.getLogById(req.db.stateless, id);
    if (!row) return error(res, 404, "Log không tồn tại");
    return success(res, row);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

module.exports = { list, getById };
