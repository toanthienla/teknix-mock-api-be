const svc = require("../services/endpoint.service");
const { success } = require("../utils/response");

// Lấy danh sách endpoints theo project_id hoặc folder_id
async function listEndpoints(req, res) {
  try {
    const { project_id, folder_id } = req.query;

    // 1. Kiểm tra xem có ít nhất một tham số được cung cấp không
    if (!project_id && !folder_id) {
      return error(res, 400, 'Query parameter project_id or folder_id is required');
    }

    // 2. Tạo object filters để truyền vào service, đồng thời validate dữ liệu
    const filters = {};
    if (project_id) {
      const id = parseInt(project_id, 10);
      if (Number.isNaN(id)) {
        return error(res, 400, 'project_id must be an integer');
      }
      filters.project_id = id;
    }
    
    if (folder_id) {
      const id = parseInt(folder_id, 10);
      if (Number.isNaN(id)) {
        return error(res, 400, 'folder_id must be an integer');
      }
      filters.folder_id = id;
    }

    // 3. Gọi service với đúng cấu trúc tham số là một object
    const endpoints = await svc.getEndpoints(filters);
    
    return success(res, endpoints);

  } catch (err) {
    // 4. Lỗi server không mong muốn nên trả về status 500
    return error(res, 500, err.message);
  }
}

// Get endpoint by id
async function getEndpointById(req, res) {
  try {
    const { id } = req.params;
    const endpoint = await svc.getEndpointById(id);
    if (!endpoint) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Endpoint not found' }]
      });
    }
    return success(res, endpoint);
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}


// Create endpoint
async function createEndpoint(req, res) {
  try {
    const { folder_id, name, method, path, is_active } = req.body;
    const errors = [];

    // Validate required fields
    if (!folder_id)
      errors.push({ field: "folder_id", message: "Folder ID is required" });
    if (!name)
      errors.push({ field: "name", message: "Endpoint name is required" });
    if (!method)
      errors.push({ field: "method", message: "HTTP method is required" });
    if (!path)
      errors.push({ field: "path", message: "Path is required" });

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const result = await svc.createEndpoint({
      folder_id,
      name,
      method,
      path,
      is_active,
    });

    if (result.success === false) {
      return res.status(400).json(result);
    }

    return success(res, result.data); // plain object
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: "general", message: err.message }],
    });
  }
}


// Update endpoint
async function updateEndpoint(req, res) {
  try {
    const { id } = req.params;
    const { name, method, path, is_active } = req.body;

    const result = await svc.updateEndpoint(id, {
      name,
      method,
      path,
      is_active,
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: "id", message: "Endpoint not found" }],
      });
    }

    if (result.success === false) {
      return res.status(400).json(result);
    }

    return success(res, result.data); // plain object
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: "general", message: err.message }],
    });
  }
}

// Delete endpoint (giữ log: NULL hoá FK trước, rồi ghi log DELETE)
// Bước 1: NULL hoá endpoint_id và endpoint_response_id thuộc endpoint trong bảng log
// Bước 2: Xoá endpoint
// Bước 3: Ghi 1 dòng log DELETE để truy vết hành động
const logSvc = require("../services/project_request_log.service");
async function deleteEndpoint(req, res) {
  const started = Date.now();
  try {
    const { id } = req.params;
    const eid = parseInt(id, 10);
    const urlPath = req.originalUrl || req.path || "";
    const headersReq = req.headers || {};
    const bodyReq = req.body || {};
    const ip = (
      req.headers["x-forwarded-for"] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      req.ip ||
      ""
    )
      .toString()
      .split(",")[0]
      .trim()
      .substring(0, 45);

    // Lấy endpoint để suy ra project_id trước khi xoá
    const current = await svc.getEndpointById(eid);
    if (!current) {
      // Ghi log 404 cho action DELETE
      try {
        await logSvc.insertLog({
          project_id: null,
          endpoint_id: eid || null,
          endpoint_response_id: null,
          request_method: "DELETE",
          request_path: urlPath,
          request_headers: headersReq,
          request_body: bodyReq,
          response_status_code: 404,
          response_body: { error: { message: "Endpoint not found" } },
          ip_address: ip,
          latency_ms: 0,
        });
      } catch (_) {}
      return res.status(404).json({
        success: false,
        errors: [{ field: "id", message: "Endpoint not found" }],
      });
    }

    // NULL hoá tham chiếu trong project_request_logs: endpoint_id & endpoint_response_id thuộc endpoint
    try {
      await logSvc.nullifyEndpointAndResponses(eid);
    } catch (_) {}

    // Xoá endpoint (KHÔNG ghi log xoá theo yêu cầu)
    const result = await svc.deleteEndpoint(eid);
    return success(res, {
      message: `Endpoint with ID: ${eid} has been deleted successfully.`,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: "general", message: err.message }],
    });
  }
}

module.exports = {
  listEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
};
