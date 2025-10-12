const svc = require("../services/endpoint.service");
const { success, error } = require("../utils/response");
const statefulSvc = require("../services/endpoints_ful.service");

// Chuẩn hoá dữ liệu stateful: id = origin_id, ẩn origin_id
function presentStateful(row) {
  if (!row) return row;
  const { origin_id, ...rest } = row;
  return { ...rest, id: origin_id, is_stateful: true };
}

// Lấy danh sách endpoints (có thể lọc theo project_id hoặc folder_id)
async function listEndpoints(req, res) {
  try {
    const { project_id, folder_id } = req.query;
    const filters = {};

    if (project_id) {
      const id = parseInt(project_id, 10);
      if (Number.isNaN(id)) {
        return error(res, 400, "project_id must be an integer");
      }
      filters.project_id = id;
    }

    if (folder_id) {
      const id = parseInt(folder_id, 10);
      if (Number.isNaN(id)) {
        return error(res, 400, "folder_id must be an integer");
      }
      filters.folder_id = id;
    }

    // Bước 1: Lấy danh sách stateless như bình thường
    const result = await svc.getEndpoints(req.db.stateless, filters);
    let endpoints = result.data;

    // Bước 2: Tìm các ID của endpoint cần lấy dữ liệu stateful
    const statefulIds = endpoints
      .filter((ep) => ep.is_stateful === true)
      .map((ep) => ep.id);

    // Bước 3: Nếu có, lấy tất cả dữ liệu stateful trong MỘT lần gọi
    if (statefulIds.length > 0) {
      const { rows: statefulEndpoints } = await req.db.stateful.query(
        `SELECT * FROM endpoints_ful WHERE origin_id = ANY($1::int[])`,
        [statefulIds]
      );

      // Tạo một map để tra cứu nhanh
      const statefulMap = new Map(
        statefulEndpoints.map((sep) => [sep.origin_id, sep])
      );

      // Bước 4: Hợp nhất dữ liệu
      endpoints = endpoints.map((ep) => {
        if (ep.is_stateful === true && statefulMap.has(ep.id)) {
          return presentStateful(statefulMap.get(ep.id));
        }
        return ep;
      });
    }

    return success(res, endpoints);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Get endpoint by id
async function getEndpointById(req, res) {
  try {
    const { id } = req.params;

    // Bước 1: Luôn lấy dữ liệu từ stateless trước
    const statelessEndpoint = await svc.getEndpointById(req.db.stateless, id);

    if (!statelessEndpoint) {
      return error(res, 404, "Endpoint not found");
    }

    // Bước 2: Kiểm tra cờ is_stateful
    if (statelessEndpoint.is_stateful === true) {
      // Nếu true, tìm bản ghi stateful tương ứng bằng origin_id
      const statefulEndpoint = await statefulSvc.findByOriginId(
        statelessEndpoint.id
      );
      if (!statefulEndpoint) {
        return error(
          res,
          404,
          `Stateful data for endpoint ${id} not found, but it is marked as stateful.`
        );
      }
      // Trả về với id = origin_id để thống nhất với list
      return success(res, presentStateful(statefulEndpoint));
    }   

    // Bước 3: Nếu không, trả về dữ liệu stateless như bình thường
    return success(res, statelessEndpoint);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Create endpoint
async function createEndpoint(req, res) {
  try {
    const { folder_id, name, method, path, is_active, is_stateful } = req.body;
    const errors = [];

    // Validate required fields
    if (!folder_id)
      errors.push({ field: "folder_id", message: "Folder ID is required" });
    if (!name)
      errors.push({ field: "name", message: "Endpoint name is required" });
    if (!method)
      errors.push({ field: "method", message: "HTTP method is required" });
    if (!path) errors.push({ field: "path", message: "Path is required" });

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const result = await svc.createEndpoint(req.db.stateless, req.body);

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

    // --- NEW: Cho phép payload chỉ có { schema } ---
    const payload = { ...req.body };
    // Nếu chỉ cập nhật schema, đừng yêu cầu name/method/path
    // (service sẽ tự xử lý đẩy sang endpoints_ful khi endpoint đang stateful)
    if (payload && typeof payload.schema !== "undefined") {
      // để nguyên; không ép buộc field khác
    }
    const result = await svc.updateEndpoint(
      req.db.stateless,
      req.db.stateful,
      id,
      payload
    );

    // Không tìm thấy endpoint
    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: "id", message: "Endpoint not found" }],
      });
    }

    // Lỗi validate hoặc business logic
    if (result.success === false) {
      return res.status(400).json(result);
    }

    // Thành công
    return success(res, result.data);
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
    const current = await svc.getEndpointById(req.db.stateless, eid);
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
      await logSvc.nullifyEndpointAndResponses(req.db.stateless, eid);
    } catch (_) {}

    // Xoá endpoint (KHÔNG ghi log xoá theo yêu cầu)
    const result = await svc.deleteEndpoint(req.db.stateless, eid);
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
