const svc = require('../services/project_request_log.service');
const { success, error } = require('../utils/response');

// API: Liệt kê logs theo project và filter (phục vụ audit/analytics)
// GET /project_request_logs?project_id=..&endpoint_id=..&method=GET&path=/users&status_code=200&from=...&to=...&limit=50&offset=0
async function list(req, res) {
  try {
    const { folder_id, endpoint_id, method, path, status_code, from, to, limit, offset } = req.query;
    if (!project_id) return error(res, 400, 'Cần query folder_id');

    const filters = {
      folder_id: parseInt(folder_id, 10),
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
    const rows = await svc.listLogs(filters);
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
    if (Number.isNaN(id)) return error(res, 400, 'id phải là số nguyên');
    const row = await svc.getLogById(id);
    if (!row) return error(res, 404, 'Log không tồn tại');
    return success(res, row);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

module.exports = { list, getById };
