// src/controllers/endpoints_ful.controller.js

const EndpointStatefulService = require("../services/endpoints_ful.service");

/**
 * GET /endpoints_ful?folder_id=&page=&limit=&query=&filter=&sort=
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
      } catch {
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
    const data = rows.map((ep) => ({ ...ep, is_stateful: true })); // compatibility

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
 * Lấy schema (JSONB) theo endpoint_id (endpoints.id)
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
    return res.status(200).json({ success: true, schema: result.data });
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
 * GET /endpoints/advanced   (by query)
 * ?path=/a&method=GET&workspace=WS&project=PJ
 * → Trả advanced_config theo endpoint (stateful)
 */
async function getAdvancedConfig(req, res) {
  try {
    const db = (req.db && (req.db.pool || req.db.stateless)) || req.app.get("dbPool");
    const path = req.query?.path;
    const method = (req.query?.method || "GET").toString().toUpperCase();
    const workspace = req.query?.workspace ? String(req.query.workspace) : null;
    const project = req.query?.project ? String(req.query.project) : null;

    if (!path || typeof path !== "string") {
      return res.status(400).json({ code: 400, message: "Thiếu hoặc sai 'path'.", data: null, success: false });
    }

    // 1) Tìm endpoint theo path+method (+workspace/project nếu có)
    const params = [method, path];
    let sql = `
      SELECT e.id, e.is_stateful, e.is_active, e.path, e.method,
             p.name AS project_name, w.name AS workspace_name
      FROM endpoints e
      JOIN folders    f ON f.id = e.folder_id
      JOIN projects   p ON p.id = f.project_id
      JOIN workspaces w ON w.id = p.workspace_id
      WHERE UPPER(e.method) = $1
        AND e.path = $2
    `;
    if (workspace) {
      sql += ` AND LOWER(w.name) = LOWER($${params.length + 1})`;
      params.push(workspace);
    }
    if (project) {
      sql += ` AND LOWER(p.name) = LOWER($${params.length + 1})`;
      params.push(project);
    }
    const { rows: candidates } = await db.query(sql, params);

    if (candidates.length === 0) {
      return res.status(404).json({
        code: 404,
        message: "Không tìm thấy endpoint theo path/method (hoặc workspace/project).",
        data: null,
        success: false,
      });
    }
    if (candidates.length > 1 && (!workspace || !project)) {
      const choices = candidates.map((r) => ({
        workspaceName: r.workspace_name,
        projectName: r.project_name,
        path: r.path,
        method: r.method,
        endpoint_id: r.id,
      }));
      return res.status(409).json({
        code: 409,
        message: "Nhiều endpoint trùng path/method. Hãy truyền thêm workspace & project.",
        data: choices,
        success: false,
      });
    }

    const ep = candidates[0];

    // 2) Lấy advanced_config trong endpoints_ful theo endpoint_id
    const { rows: ful } = await db.query(
      `SELECT id, endpoint_id, is_active, advanced_config
         FROM endpoints_ful
        WHERE endpoint_id = $1
        LIMIT 1`,
      [ep.id]
    );

    if (ful.length === 0) {
      return res.status(404).json({
        code: 404,
        message: "Endpoint chưa có bản ghi stateful (endpoints_ful).",
        data: { endpoint_id: ep.id, workspaceName: ep.workspace_name, projectName: ep.project_name, path: ep.path },
        success: false,
      });
    }

    const ef = ful[0];
    return res.status(200).json({
      code: 200,
      message: "Success",
      data: {
        id: ef.id,
        endpoint_id: ep.id,
        workspaceName: ep.workspace_name,
        projectName: ep.project_name,
        path: ep.path,
        method: ep.method,
        is_stateful: true,
        is_active: !!ef.is_active,
        advanced_config: ef.advanced_config || null,
      },
      success: true,
    });
  } catch (err) {
    console.error("⚠️ Lỗi khi lấy advanced_config (by path):", err);
    return res.status(500).json({
      code: 500,
      message: "Lỗi máy chủ khi lấy advanced_config.",
      data: null,
      success: false,
    });
  }
}

/**
 * PUT /endpoints/advanced/:id  (legacy by endpoint_id)
 * body: { advanced_config: {...} }
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

    // Bạn sẽ implement trong service:
    //   updateAdvancedConfigByEndpointId(id, req.body)
    // (giữ fallback theo origin nếu bạn còn dùng)
    let result = typeof EndpointStatefulService.updateAdvancedConfigByEndpointId === "function" ? await EndpointStatefulService.updateAdvancedConfigByEndpointId(id, req.body) : null;

    if (!result && typeof EndpointStatefulService.updateAdvancedConfigByOriginId === "function") {
      result = await EndpointStatefulService.updateAdvancedConfigByOriginId(id, req.body);
    }

    if (result?.notFound) {
      return res.status(404).json({ error: "Không tìm thấy endpoint stateful với endpoint_id này." });
    }

    return res.status(200).json({
      code: 200,
      message: "Cập nhật advanced_config thành công.",
      data: { id: result.id, endpoint_id: Number(id), advanced_config: result.advanced_config },
      success: true,
    });
  } catch (err) {
    console.error("⚠️ Lỗi khi cập nhật advanced_config:", err);
    return res.status(500).json({ error: err.message || "Lỗi máy chủ khi cập nhật advanced_config." });
  }
}

/**
 * GET /endpoints/advanced/path  → chỉ trả các path đang hoạt động ở STATEFUL
 * Optional: ?method=GET&workspace=WS&project=PJ&plainOnly=true
 */
async function getActiveStatefulPathsCtrl(req, res) {
  try {
    const db = (req.db && (req.db.pool || req.db.stateless)) || req.app.get("dbPool");

    const method = req.query?.method ? String(req.query.method).toUpperCase() : null;
    const workspace = req.query?.workspace ? String(req.query.workspace) : null;
    const project = req.query?.project ? String(req.query.project) : null;
    const plainOnly = String(req.query?.plainOnly || "").toLowerCase() === "true";

    const params = [];
    let i = 1;
    let sql = `
      SELECT DISTINCT
        w.name AS workspace_name,
        p.name AS project_name,
        e.path AS path
      FROM endpoints e
      JOIN folders      f   ON f.id = e.folder_id
      JOIN projects     p   ON p.id = f.project_id
      JOIN workspaces   w   ON w.id = p.workspace_id
      JOIN endpoints_ful ef ON ef.endpoint_id = e.id
      WHERE e.is_stateful = TRUE
        AND ef.is_active   = TRUE
        AND e.is_active    = FALSE
    `;
    if (method) {
      sql += ` AND UPPER(e.method) = $${i++}`;
      params.push(method);
    }
    if (workspace) {
      sql += ` AND LOWER(w.name) = LOWER($${i++})`;
      params.push(workspace);
    }
    if (project) {
      sql += ` AND LOWER(p.name) = LOWER($${i++})`;
      params.push(project);
    }
    if (plainOnly) {
      sql += ` AND e.path NOT LIKE '%:%' AND e.path NOT LIKE '%*%'`;
    }
    sql += ` ORDER BY w.name, p.name, e.path`;

    const { rows } = await db.query(sql, params);
    const data = rows.map((r) => ({
      workspaceName: r.workspace_name,
      projectName: r.project_name,
      path: r.path,
    }));

    return res.status(200).json({
      code: 200,
      message: "Success",
      data,
      success: true,
    });
  } catch (err) {
    console.error("[getActiveStatefulPathsCtrl] error:", err);
    return res.status(500).json({
      code: 500,
      message: "Server error when listing active stateful paths.",
      data: null,
      success: false,
    });
  }
}

/**
 * (Legacy) by-origin → dùng list locations mới (nếu còn route cũ)
 */
async function getEndpointsByOrigin(req, res) {
  console.warn("[DEPRECATED] getEndpointsByOrigin -> use /endpoints/advanced/path");
  return getActiveStatefulPathsCtrl(req, res);
}

// --- Export tập trung ---
module.exports = {
  // Listing/CRUD stateful
  listEndpoints,
  getEndpointById,
  deleteEndpointById,
  convertToStateful,
  revertToStateless,
  updateEndpointResponse,

  // Schema
  getEndpointSchema,
  getBaseSchemaByEndpoint,

  // Advanced config
  getAdvancedConfig, // by query (?path=&method=&workspace=&project=)
  updateAdvancedConfig, // legacy by :id

  // Locations (stateful only)
  getActiveStatefulPathsCtrl,

  // Deprecated
  getEndpointsByOrigin,
};
