// src/controllers/endpoints_ful.controller.js

const EndpointStatefulService = require("../services/endpoints_ful.service");

// Locations (workspace/project/path) listing
const { getAllEndpointLocations, getEndpointLocationsByPath } = require("../services/endpoints_ful.service");

/**
 * GET /endpoints_ful?folder_id=...&page=&limit=&query=&filter=&sort=
 * Liệt kê stateful endpoints theo folder_id (phân trang + search/filter/sort)
 */
async function listEndpoints(req, res) {
  try {
    const { folder_id } = req.query;
    if (!folder_id) {
      return res.status(400).json({ error: "folder_id là bắt buộc." });
    }

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;

    const q = typeof req.query.query === "string" && req.query.query.trim() ? req.query.query.trim() : null;

    let filter = null;
    if (req.query.filter) {
      const raw = req.query.filter;
      try {
        filter =
          typeof raw === "string" && raw.trim().startsWith("{")
            ? JSON.parse(raw)
            : Object.fromEntries(
                String(raw)
                  .split(",")
                  .map((p) => p.split(":", 2))
              );
      } catch (e) {
        return res.status(400).json({ error: "Invalid filter format" });
      }
    }

    let sort = null;
    if (req.query.sort) {
      const [field, dir] = String(req.query.sort).split(":", 2);
      sort = { field: field || null, dir: dir || "asc" };
    }

    const opts = { page, limit, query: q, filter, sort };
    const { rows, total } = await EndpointStatefulService.findByFolderIdPaged(folder_id, opts);

    // Thêm cờ is_stateful=true để tương thích ngược
    const data = rows.map((ep) => ({ ...ep, is_stateful: true }));

    return res.status(200).json({
      code: 200,
      message: "Success",
      data,
      page: Number(page),
      limit: Number(limit),
      total,
      success: true,
    });
  } catch (err) {
    console.error("listEndpoints error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /endpoints_ful/:id
 * Lấy đầy đủ thông tin 1 stateful endpoint (id = endpoints_ful.id)
 */
async function getEndpointById(req, res) {
  try {
    const { id } = req.params;
    const endpointDetail = await EndpointStatefulService.getFullDetailById(id);

    if (!endpointDetail) {
      return res.status(404).json({ error: "Không tìm thấy stateful endpoint." });
    }

    return res.status(200).json({
      code: 200,
      message: "Success",
      data: endpointDetail,
      success: true,
    });
  } catch (err) {
    console.error("getEndpointById error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * DELETE /endpoints_ful/:id
 * Xoá stateful endpoint (id = endpoints_ful.id)
 */
async function deleteEndpointById(req, res) {
  try {
    const { id } = req.params;
    const result = await EndpointStatefulService.deleteById(parseInt(id, 10));

    if (result?.notFound) {
      return res.status(404).json({ error: "Không tìm thấy stateful endpoint." });
    }

    return res.status(204).send();
  } catch (err) {
    console.error("deleteEndpointById error:", err);
    return res.status(500).json({ error: "Lỗi máy chủ nội bộ." });
  }
}

/**
 * POST /endpoints/:id/convert-to-stateful
 * id = endpoints.id (endpoint gốc)
 */
async function convertToStateful(req, res) {
  const { id } = req.params;
  try {
    const result = await EndpointStatefulService.convertToStateful(parseInt(id, 10));
    return res.status(200).json({
      code: 200,
      message: "Endpoint converted to stateful successfully",
      data: result,
      success: true,
    });
  } catch (err) {
    console.error("Error convertToStateful:", err?.message || err);
    return res.status(500).json({ error: err.message || "Convert failed" });
  }
}

/**
 * POST /endpoints/:id/revert-to-stateless
 * id = endpoints.id (endpoint gốc)
 */
async function revertToStateless(req, res) {
  const { id } = req.params;
  try {
    const result = await EndpointStatefulService.revertToStateless(parseInt(id, 10));
    return res.status(200).json({
      code: 200,
      message: "Endpoint reverted to stateless successfully",
      data: { endpoint_id: parseInt(id, 10), ...result },
      success: true,
    });
  } catch (err) {
    console.error("Error revertToStateless:", err);
    return res.status(500).json({ error: err.message || "Revert to stateless failed" });
  }
}

/**
 * PUT /endpoint_responses_ful/:id
 * Cập nhật response stateful (id = endpoint_responses_ful.id)
 * body: { response_body, delay | delay_ms }
 */
async function updateEndpointResponse(req, res) {
  try {
    const { id } = req.params;
    const response_body = req.body.response_body ?? req.body.responseBody;
    const delay = req.body.delay ?? req.body.delay_ms;

    const updated = await EndpointStatefulService.updateEndpointResponse(parseInt(id, 10), { response_body, delay });

    return res.status(200).json({
      code: 200,
      message: "Response updated successfully",
      data: updated,
      success: true,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

/**
 * GET /endpoints/schema_get/:id
 * Lấy schema (JSONB) của stateful endpoint theo endpoint_id (endpoints.id)
 */
async function getEndpointSchema(req, res) {
  try {
    const { id } = req.params;
    const result = await EndpointStatefulService.getEndpointSchema(req.db.stateful, id);

    if (!result?.success) {
      return res.status(404).json({
        success: false,
        errors: [{ field: "id", message: result?.message || "Not found" }],
      });
    }

    return res.status(200).json({
      success: true,
      schema: result.data,
    });
  } catch (err) {
    console.error("Error in controller getEndpointSchema:", err);
    return res.status(500).json({
      success: false,
      errors: [{ field: "general", message: err.message }],
    });
  }
}

/**
 * GET /endpoints/base_schema/:id
 * Lấy base_schema của folder chứa endpoint (id = endpoints.id)
 */
async function getBaseSchemaByEndpoint(req, res) {
  try {
    const { id } = req.params;
    const result = await EndpointStatefulService.getBaseSchemaByEndpointId(req.db.stateless, id);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(404).json({
      success: false,
      errors: [{ field: "id", message: err.message }],
    });
  }
}

/**
 * GET /endpoints/advanced/:id
 * Lấy advanced_config theo endpoint_id (endpoints.id)
 */
async function getAdvancedConfig(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "endpoint_id là bắt buộc." });
    }

    // DB mới: ưu tiên tìm theo endpoint_id
    let endpoint = typeof EndpointStatefulService.findByEndpointIdRaw === "function" ? await EndpointStatefulService.findByEndpointIdRaw(id) : null;

    // Fallback nếu service của bạn chưa đổi tên
    if (!endpoint && typeof EndpointStatefulService.findByOriginIdRaw === "function") {
      endpoint = await EndpointStatefulService.findByOriginIdRaw(id);
    }

    if (!endpoint) {
      return res.status(404).json({ error: "Không tìm thấy endpoint stateful với endpoint_id này." });
    }

    return res.status(200).json({
      code: 200,
      message: "Success",
      data: {
        id: endpoint.id, // endpoints_ful.id
        endpoint_id: Number(id),
        advanced_config: endpoint.advanced_config || null,
      },
      success: true,
    });
  } catch (err) {
    console.error("⚠️ Lỗi khi lấy advanced_config:", err);
    return res.status(500).json({ error: "Lỗi máy chủ khi lấy advanced_config." });
  }
}

/**
 * PUT /endpoints/advanced/:id
 * Cập nhật advanced_config (JSONB) theo endpoint_id (endpoints.id)
 * body: { advanced_config: { ... } }
 */
async function updateAdvancedConfig(req, res) {
  try {
    const { id } = req.params;
    const { advanced_config } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: "endpoint_id là bắt buộc." });
    }
    if (!advanced_config || typeof advanced_config !== "object") {
      return res.status(400).json({ error: "Trường 'advanced_config' phải là object JSON hợp lệ." });
    }

    // DB mới: ưu tiên update theo endpoint_id
    let result = typeof EndpointStatefulService.updateAdvancedConfigByEndpointId === "function" ? await EndpointStatefulService.updateAdvancedConfigByEndpointId(id, req.body) : null;

    // Fallback nếu service của bạn chưa đổi tên
    if (!result && typeof EndpointStatefulService.updateAdvancedConfigByOriginId === "function") {
      result = await EndpointStatefulService.updateAdvancedConfigByOriginId(id, req.body);
    }

    if (result?.notFound) {
      return res.status(404).json({ error: "Không tìm thấy endpoint stateful với endpoint_id này." });
    }

    return res.status(200).json({
      code: 200,
      message: "Cập nhật advanced_config thành công.",
      data: {
        id: result.id, // endpoints_ful.id
        endpoint_id: Number(id),
        advanced_config: result.advanced_config,
      },
      success: true,
    });
  } catch (err) {
    console.error("⚠️ Lỗi khi cập nhật advanced_config:", err);
    return res.status(500).json({ error: err.message || "Lỗi máy chủ khi cập nhật advanced_config." });
  }
}

/**
 * GET /endpoints/locations
 * GET /endpoints/locations?path=/a
 * Trả về danh sách duy nhất { workspaceName, projectName, path }
 */
async function getEndpointLocations(req, res) {
  try {
    const { path } = req.query || {};
    const dbPool = (req.db && (req.db.pool || req.db.stateless)) || req.app.get("dbPool");

    const data = path ? await getEndpointLocationsByPath(dbPool, path) : await getAllEndpointLocations(dbPool);

    return res.status(200).json({
      code: 200,
      message: "Success",
      data,
      success: true,
    });
  } catch (err) {
    console.error("[getEndpointLocations] error:", err);
    return res.status(500).json({
      code: 500,
      message: "Server error when listing endpoint locations.",
      data: null,
      success: false,
    });
  }
}

/**
 * Giữ tương thích tạm thời (route cũ): by-origin → dùng list locations
 */
async function getEndpointsByOrigin(req, res) {
  console.warn("[DEPRECATED] getEndpointsByOrigin -> use getEndpointLocations");
  return getEndpointLocations(req, res);
}

// --- Export tập trung ---
module.exports = {
  listEndpoints,
  getEndpointById,
  deleteEndpointById,
  convertToStateful,
  revertToStateless,
  updateEndpointResponse,
  getEndpointSchema,
  getBaseSchemaByEndpoint,
  getAdvancedConfig,
  updateAdvancedConfig,
  getEndpointLocations,
  getEndpointsByOrigin, // tạm giữ nếu route cũ còn dùng
};
