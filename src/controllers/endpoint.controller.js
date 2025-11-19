const svc = require("../services/endpoint.service");
const { success, error } = require("../utils/response");

// Helper: dựng lại schema theo __order và strip __order khỏi response
function orderAndStripSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const order = Array.isArray(schema.__order) ? schema.__order : null;
  if (!order) return schema;
  const out = {};
  for (const k of order) {
    if (Object.prototype.hasOwnProperty.call(schema, k)) {
      out[k] = schema[k];
    }
  }
  // thêm các key còn lại (nếu có), bỏ qua __order
  for (const k of Object.keys(schema)) {
    if (k !== "__order" && !Object.prototype.hasOwnProperty.call(out, k)) {
      out[k] = schema[k];
    }
  }
  return out;
}

// Hợp nhất meta stateful (từ endpoints_ful) vào endpoint stateless
function mergeStatefulIntoEndpoint(ep, fulRow) {
  if (!fulRow) return ep;
  const schemaOut = orderAndStripSchema(fulRow.schema);
  return {
    ...ep,
    schema: schemaOut,
    advanced_config: fulRow.advanced_config ?? null,
    stateful_id: fulRow.id, // id của bản ghi ở endpoints_ful (tham khảo/diagnostic)
    is_stateful: true,
  };
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
    const statefulIds = endpoints.filter((ep) => ep.is_stateful === true).map((ep) => ep.id);

    // Bước 3: Nếu có, lấy tất cả dữ liệu stateful trong MỘT lần gọi
    if (statefulIds.length > 0) {
      // Schema mới: endpoints_ful liên kết qua endpoint_id
      const { rows: statefulEndpoints } = await req.db.stateless.query(
        `SELECT id, endpoint_id, schema, advanced_config
           FROM endpoints_ful
          WHERE endpoint_id = ANY($1::int[])`,
        [statefulIds]
      );
      const statefulMap = new Map(statefulEndpoints.map((r) => [r.endpoint_id, r]));
      // Bước 4: Hợp nhất (giữ thông tin endpoint gốc, tiêm schema/advanced_config/stateful_id)
      endpoints = endpoints.map((ep) => (ep.is_stateful === true && statefulMap.has(ep.id) ? mergeStatefulIntoEndpoint(ep, statefulMap.get(ep.id)) : ep));
    }

    return success(res, endpoints);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

async function getEndpointById(req, res) {
  try {
    const { id } = req.params;

    // --- Bước 1: lấy từ stateless ---
    const statelessEndpoint = await svc.getEndpointById(req.db.stateless, id);
    if (!statelessEndpoint) {
      return error(res, 404, "Endpoint not found");
    }

    // --- Bước 2: Nếu endpoint có stateful ---
    if (statelessEndpoint.is_stateful === true) {
      // Schema mới: tra meta stateful theo endpoint_id
      const {
        rows: [ful],
      } = await req.db.stateless.query(
        `SELECT id, endpoint_id, schema, advanced_config
           FROM endpoints_ful
          WHERE endpoint_id = $1
          LIMIT 1`,
        [statelessEndpoint.id]
      );
      if (!ful) {
        return error(res, 404, `Stateful data for endpoint ${id} not found, but it is marked as stateful.`);
      }
      return success(res, mergeStatefulIntoEndpoint(statelessEndpoint, ful));
    }

    // --- Bước 3: Trả về stateless ---
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
    if (!folder_id) errors.push({ field: "folder_id", message: "Folder ID is required" });
    if (!name) errors.push({ field: "name", message: "Endpoint name is required" });
    if (!method) errors.push({ field: "method", message: "HTTP method is required" });
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

// GET /endpoints/:id/websocket
async function getEndpointWebsocketConfigCtrl(req, res) {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return error(res, 400, "Invalid endpoint id.");
  const row = await svc.getWebsocketConfigById(id);
  if (!row) return error(res, 404, "Endpoint not found");
  return success(res, row.websocket_config || {});
}

// PUT /endpoints/:id/websocket
async function updateEndpointWebsocketConfigCtrl(req, res) {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return error(res, 400, "Invalid endpoint id.");
  const cfg = req.body || {};
  // (đã validate ở middleware riêng hoặc ở route này có thể chấp nhận trực tiếp)
  const row = await svc.updateWebsocketConfigById(id, cfg);
  if (!row) return error(res, 404, "Endpoint not found");
  return success(res, row.websocket_config || {});
}

// Update endpoint controller
async function updateEndpoint(req, res) {
  try {
    const { id } = req.params;
    const payload = { ...req.body };

    // 🔁 Normalize: nếu client gửi { fields:[...] } -> chuyển thành { schema:{ fields:[...] } }
    if (req.method === "PUT" && Array.isArray(payload.fields) && Object.keys(payload).length === 1) {
      payload.schema = { fields: payload.fields };
      delete payload.fields;
    }

    // --- Cho phép payload có: 
    //     - { name, path } hoặc subset
    //     - { schema } riêng
    //     - { websocket_config } riêng ---
    const result = await svc.updateEndpoint(req.db.stateless, req.db.stateful, id, payload);

    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: "id", message: "Endpoint not found" }],
      });
    }

    if (result.success === false) {
      return res.status(400).json(result);
    }

    // Giữ thứ tự keys theo payload.schema (nếu có)
    let data = result.data;
    if (payload && payload.schema && typeof payload.schema === "object" && !Array.isArray(payload.schema)) {
      const order = Object.keys(payload.schema);
      const src = data?.schema && typeof data.schema === "object" ? data.schema : {};
      const reordered = {};
      for (const k of order) if (Object.prototype.hasOwnProperty.call(src, k)) reordered[k] = src[k];
      for (const k of Object.keys(src)) if (!Object.prototype.hasOwnProperty.call(reordered, k)) reordered[k] = src[k];
      data = { ...data, schema: reordered };
    }

    return success(res, data);
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
    const ip = (req.headers["x-forwarded-for"] || req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || "").toString().split(",")[0].trim().substring(0, 45);

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

    // Xoá endpoint (service đã tự null-hoá stateful_* & dọn _ful)
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

// PATCH /endpoints/:id/notification  { send_notification: true|false }
async function setNotificationFlag(req, res) {
  const id = Number(req.params.id);
  const { send_notification } = req.body ?? {};

  if (Number.isNaN(id)) return error(res, 400, "Invalid endpoint id.");
  if (typeof send_notification !== "boolean") {
    return error(res, 400, "Field 'send_notification' must be boolean.");
  }

  const result = await svc.setSendNotification(req.db.stateless, id, send_notification);
  if (!result.success) return error(res, 404, result.message || "Endpoint not found.");
  return success(res, result.data);
}

// Alias: PATCH /endpoints/:id/send        → true
async function enableNotification(req, res) {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return error(res, 400, "Invalid endpoint id.");
  const result = await svc.setSendNotification(req.db.stateless, id, true);
  if (!result.success) return error(res, 404, result.message || "Endpoint not found.");
  return success(res, result.data);
}

// Alias: PATCH /endpoints/:id/not-send    → false
async function disableNotification(req, res) {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return error(res, 400, "Invalid endpoint id.");
  const result = await svc.setSendNotification(req.db.stateless, id, false);
  if (!result.success) return error(res, 404, result.message || "Endpoint not found.");
  return success(res, result.data);
}

module.exports = {
  listEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  setNotificationFlag,
  enableNotification,
  disableNotification,
  getEndpointWebsocketConfigCtrl,
  updateEndpointWebsocketConfigCtrl,
};
