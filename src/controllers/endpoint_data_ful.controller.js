const EndpointStatefulService = require("../services/endpoints_ful.service");
const DataStatefulService = require("../services/endpoint_data_ful.service");
const ResponseSvc = require("../services/endpoint_response.service");

// ---- Local helpers: reuse logic style from statefulHandler (isTypeOK) ----
function isTypeOK(expected, value) {
  if (value === undefined) return true; // missing -> sẽ do 'required' kiểm tra
  if (expected === "number") return typeof value === "number" && !Number.isNaN(value);
  if (expected === "string") return typeof value === "string" && String(value).trim() !== "";
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  return true;
}

/**
 * Validate 1 object theo base_schema dạng:
 * {
 *   "id":   { "type": "number", "required": false },
 *   "name": { "type": "string", "required": true  },
 *   ...
 * }
 * - Từ chối field lạ (rejectUnknown = true)
 * - Kiểm tra thiếu required
 * - Kiểm tra sai type
 */
function validateOneAgainstBaseSchema(baseSchema, obj, { rejectUnknown = true } = {}) {
  const errors = [];
  const keys = Object.keys(baseSchema || {});

  if (rejectUnknown) {
    const unknown = Object.keys(obj || {}).filter((k) => !keys.includes(k));
    if (unknown.length) errors.push(`Unknown fields: ${unknown.join(", ")}`);
  }

  for (const k of keys) {
    const rule = baseSchema[k] || {};
    const has = Object.prototype.hasOwnProperty.call(obj || {}, k);
    const val = obj?.[k];

    if (rule.required === true && !has) {
      errors.push(`Missing required field: ${k}`);
      continue;
    }
    if (has && rule.type && !isTypeOK(rule.type, val)) {
      errors.push(`Invalid type for ${k}: expected ${rule.type}`);
    }
  }
  return errors;
}

// Parse workspace/project/path từ query:
//  - Dạng tách:  ?workspace=WP_3&project=pj_3&path=/cat
//  - Dạng gộp:   ?path=WP_3/pj_3/cat
function parseWPPath(req) {
  const ensureLeadingSlash = (p) => {
    if (!p || String(p).trim() === "") return null;
    return p.startsWith("/") ? p : "/" + p;
  };
  const splitWP = (raw) => {
    if (!raw) return null;
    const clean = String(raw).replace(/^\/+/, "");
    const segs = clean.split("/").filter(Boolean);
    if (segs.length >= 3) {
      const ws = decodeURIComponent(segs[0]);
      const pj = decodeURIComponent(segs[1]);
      const rest = "/" + segs.slice(2).join("/");
      return { ws, pj, rest };
    }
    return null;
  };

  let { path, workspace, project } = req.query || {};
  const opts = {};

  // Ưu tiên dạng tách
  if (workspace && project) {
    opts.workspaceName = String(workspace);
    opts.projectName = String(project);
    return { pgPath: ensureLeadingSlash(path), opts };
  }
  // Thử dạng gộp
  const parsed = splitWP(path);
  if (parsed) {
    opts.workspaceName = parsed.ws;
    opts.projectName = parsed.pj;
    return { pgPath: parsed.rest, opts };
  }
  // Fallback legacy: chỉ có path
  return { pgPath: ensureLeadingSlash(path), opts };
}

/**
 * Lấy dữ liệu stateful theo path
 */
exports.getDataByPath = async (req, res) => {
  try {
    const { pgPath, opts } = parseWPPath(req);
    if (!pgPath) return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });

    // Dùng service endpoints_ful để đảm bảo lookup theo /path và đọc đúng collection WS/Project
    const data = await EndpointStatefulService.getEndpointData(pgPath, opts);
    return res.status(200).json(data);
  } catch (err) {
    console.error("Error in getDataByPath:", err.message);
    const status = /không tìm thấy/i.test(err.message) ? 404 : 500;
    return res.status(status).json({ error: err.message || "Lỗi máy chủ nội bộ." });
  }
};

/**
 * Xóa dữ liệu stateful theo path
 * Chức năng này cũng chưa có trong service, cần bổ sung
 */
exports.deleteDataByPath = async (req, res) => {
  try {
    const { pgPath, opts } = parseWPPath(req);
    if (!pgPath) return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });

    if (typeof EndpointStatefulService.deleteEndpointData === "function") {
      const ok = await EndpointStatefulService.deleteEndpointData(pgPath, opts);
      if (!ok) return res.status(404).json({ error: `Không tìm thấy dữ liệu với path: '${pgPath}'` });
      return res.status(204).send();
    }
    // Fallback sang data service cũ nếu bạn chưa implement xoá trong endpoints_ful.service
    const ok = await DataStatefulService.deleteByPath(pgPath, opts);
    if (!ok) return res.status(404).json({ error: `Không tìm thấy dữ liệu với path: '${pgPath}'` });
    return res.status(204).send();
  } catch (err) {
    console.error("Error in deleteDataByPath:", err.message);
    const status = /không tìm thấy/i.test(err.message) ? 404 : 500;
    res.status(status).json({ error: err.message || "Lỗi máy chủ nội bộ." });
  }
};

/**
 * Cập nhật dữ liệu (schema và data_default) cho một endpoint
 */
exports.updateEndpointData = async (req, res) => {
  try {
    const { pgPath, opts } = parseWPPath(req);
    if (!pgPath) return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "Request body không được để trống." });
    }

    const { schema, data_default } = req.body;

    // Nếu đang cập nhật data_default thì validate theo base_schema của folder chứa endpoint
    if (data_default !== undefined) {
      const { rows: bsRows } = await req.db.stateless.query(
        `
        SELECT f.base_schema
        FROM endpoints e
        JOIN folders   f ON e.folder_id   = f.id
        JOIN projects  p ON f.project_id  = p.id
        JOIN workspaces w ON p.workspace_id = w.id
        WHERE w.name = $1 AND p.name = $2 AND e.path = $3
        LIMIT 1
        `,
        [opts.workspaceName, opts.projectName, pgPath]
      );
      let baseSchema = bsRows?.[0]?.base_schema || null;
      if (typeof baseSchema === "string") {
        try {
          baseSchema = JSON.parse(baseSchema);
        } catch {}
      }
      if (baseSchema && typeof baseSchema === "object") {
        const base = baseSchema.properties || baseSchema;
        const arr = Array.isArray(data_default) ? data_default : [data_default];
        const allErrors = [];
        arr.forEach((item, idx) => {
          const errs = validateOneAgainstBaseSchema(base, item, { rejectUnknown: true });
          if (errs.length) allErrors.push(`Phần tử thứ ${idx}: ${errs.join("; ")}`);
        });
        if (allErrors.length) {
          return res.status(400).json({
            error: "data_default không khớp base_schema của folder",
            details: allErrors,
          });
        }
      }
    }

    const result = await EndpointStatefulService.updateEndpointData(
      pgPath,
      {
        schema,
        data_default,
      },
      opts
    );

    return res.status(200).json({
      message: "Cập nhật dữ liệu endpoint thành công.",
      data: result,
    });
  } catch (err) {
    console.error("Error in updateEndpointData:", err.message);
    const statusCode = /không tìm thấy/i.test(err.message) ? 404 : 500;
    return res.status(statusCode).json({ error: err.message });
  }
};

/**
 * Thiết lập dữ liệu hiện tại làm dữ liệu mặc định
 */
exports.setDefaultEndpointData = async (req, res) => {
  try {
    const { pgPath, opts } = parseWPPath(req);
    const { data_default } = req.body || {};

    if (!pgPath) return res.status(400).json({ error: "Thiếu query 'path'." });
    if (data_default === undefined) return res.status(400).json({ error: "Thiếu 'data_default' trong payload." });

    // 1) Lấy base_schema của folder chứa endpoint theo (workspace, project, path)
    //    Dùng DB stateless để join w -> p -> f -> e
    const { rows: bsRows } = await req.db.stateless.query(
      `
      SELECT f.base_schema
      FROM endpoints e
      JOIN folders   f ON e.folder_id   = f.id
      JOIN projects  p ON f.project_id  = p.id
      JOIN workspaces w ON p.workspace_id = w.id
      WHERE w.name = $1 AND p.name = $2 AND e.path = $3
      LIMIT 1
      `,
      [opts.workspaceName, opts.projectName, pgPath]
    );

    let baseSchema = bsRows?.[0]?.base_schema || null;
    if (typeof baseSchema === "string") {
      try {
        baseSchema = JSON.parse(baseSchema);
      } catch {
        /* keep raw */
      }
    }

    // 2) Nếu có base_schema thì validate data_default theo schema này
    if (baseSchema && typeof baseSchema === "object") {
      const base = baseSchema.properties || baseSchema; // chấp nhận cả dạng có "properties"
      const arr = Array.isArray(data_default) ? data_default : [data_default];
      const allErrors = [];
      arr.forEach((item, idx) => {
        const errs = validateOneAgainstBaseSchema(base, item, { rejectUnknown: true });
        if (errs.length) {
          allErrors.push(`Phần tử thứ ${idx}: ${errs.join("; ")}`);
        }
      });
      if (allErrors.length) {
        return res.status(400).json({
          error: "data_default không khớp base_schema của folder",
          details: allErrors,
        });
      }
    }

    // 3) Ghi vào Mongo và đồng bộ current = default
    const result = await DataStatefulService.upsertDefaultAndCurrentByPath(pgPath, data_default, opts);
    return res.status(200).json({
      message: "Cập nhật data_default (đồng bộ data_current) thành công.",
      data: result,
    });
  } catch (err) {
    console.error("Error in setDefaultEndpointData:", err);
    const status = /không tìm thấy/i.test(err.message) ? 404 : 500;
    return res.status(status).json({ error: err.message });
  }
};
