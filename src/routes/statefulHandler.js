// src/routes/statefulHandler.js
const { getCollection } = require("../config/db");
const logSvc = require("../services/project_request_log.service");

// ============ Generic helpers ============
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.connection?.remoteAddress ||
    req.ip ||
    null
  );
}
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}
function renderTemplateDeep(value, ctx) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}/g, (_, path) => {
      const v = getByPath(ctx, path);
      return v === undefined || v === null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplateDeep(v, ctx));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderTemplateDeep(v, ctx);
    return out;
  }
  return value;
}
function normalizeJsonb(x) {
  if (x == null) return x;
  if (typeof x === "string") {
    try { return JSON.parse(x); } catch { return x; }
  }
  return x;
}

// ============ endpoint_responses_ful bucket ============
async function loadResponsesBucket(db, endpointId) {
  const { rows } = await db.query(
    `SELECT id, status_code, response_body
       FROM endpoint_responses_ful
      WHERE endpoint_id = $1
      ORDER BY id ASC`,
    [endpointId]
  );
  const bucket = new Map();
  for (const r of rows) {
    const body = normalizeJsonb(r.response_body);
    const key = Number(r.status_code);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push({ id: Number(r.id), body });
  }
  return bucket;
}

// --- Response picking & templating with ordered {{params.id}} ---
function renderTemplateWithOrderedParamsId(tpl, ctx) {
  if (typeof tpl !== "string") return tpl;
  if (ctx?.params && ctx.params.id_conflict != null) {
    let count = 0;
    return tpl
      .replace(/\{\{\s*params\.id\s*\}\}/g, () => {
        count += 1;
        return String(count === 1 ? ctx.params.id : ctx.params.id_conflict);
      })
      .replace(/\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}/g, (_, path) => {
        if (path === "params.id") return "";
        const v = getByPath(ctx, path);
        return v == null ? "" : String(v);
      });
  }
  return renderTemplateDeep(tpl, ctx);
}
function countParamsIdOccurrences(body) {
  const s = typeof body === "string" ? body : JSON.stringify(body || "");
  const m = s.match(/\{\{\s*params\.id\s*\}\}/g);
  return m ? m.length : 0;
}
function pickResponseEntryAdv(bucket, status, { requireParamId = null, paramsIdOccurrences = null } = {}) {
  const arr = bucket.get(status) || [];
  if (arr.length === 0) return undefined;

  let candidates = arr;
  if (requireParamId === true) {
    candidates = candidates.filter(e => countParamsIdOccurrences(e.body) >= 1);
  } else if (requireParamId === false) {
    candidates = candidates.filter(e => countParamsIdOccurrences(e.body) === 0);
  }
  if (paramsIdOccurrences != null) {
    const exact = candidates.filter(e => countParamsIdOccurrences(e.body) === paramsIdOccurrences);
    if (exact.length) candidates = exact;
  }
  return candidates[0] || arr[0];
}
function selectAndRenderResponseAdv(bucket, status, ctx, { fallback, requireParamId, paramsIdOccurrences } = {}) {
  const entry = pickResponseEntryAdv(bucket, status, { requireParamId, paramsIdOccurrences });
  const raw = entry?.body ?? fallback ?? { message: `HTTP ${status}` };
  const rendered = typeof raw === "string"
    ? renderTemplateWithOrderedParamsId(raw, ctx)
    : renderTemplateDeep(normalizeJsonb(raw), ctx);
  return { rendered, responseId: entry?.id ?? null };
}

// ============ Auth & Schema ============
function pickUserIdFromRequest(req) {
  const localsUser = req.res?.locals?.user;
  const uid =
    req.user?.id ??
    req.user?.user_id ??
    localsUser?.id ??
    localsUser?.user_id ??
    (req.headers["x-mock-user-id"] != null ? Number(req.headers["x-mock-user-id"]) : null);
  return uid != null && Number.isFinite(Number(uid)) ? Number(uid) : null;
}
function requireAuth(req, res) {
  const uid = pickUserIdFromRequest(req);
  if (uid == null) {
    res.status(403).json({ error: "Unauthorized: login required." });
    return null;
  }
  return uid;
}

function isTypeOK(expected, value) {
  if (value === undefined) return true;
  if (expected === "number") return typeof value === "number" && !Number.isNaN(value);
  if (expected === "string") return typeof value === "string";
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  return true;
}
function validateAndSanitizePayload(schema, payload, {
  allowMissingRequired = false,
  rejectUnknown = true,
}) {
  const errors = [];
  const sanitized = {};
  const schemaFields = Object.keys(schema || {});

  if (rejectUnknown) {
    const unknownKeys = Object.keys(payload || {}).filter(
      (k) => !schemaFields.includes(k) && k !== "user_id"
    );
    if (unknownKeys.length) errors.push(`Unknown fields: ${unknownKeys.join(", ")}`);
  }

  for (const key of schemaFields) {
    const rule = schema[key] || {};
    const has = Object.prototype.hasOwnProperty.call(payload, key);
    const val = payload[key];

    if (rule.required === true && !has && !allowMissingRequired) {
      errors.push(`Missing required field: ${key}`);
      continue;
    }
    if (has && rule.type && !isTypeOK(rule.type, val)) {
      errors.push(`Invalid type for ${key}: expected ${rule.type}`);
      continue;
    }
    if (has && val !== null && val !== undefined) {
      sanitized[key] = val;
    }
  }
  if (schemaFields.includes("id") && payload.id !== undefined) {
    sanitized.id = payload.id;
  }
  return { ok: errors.length === 0, errors, sanitized };
}

// ============ Logging util ============
async function insertLogSafely(req, {
  projectId,
  originId,
  method,
  path,
  status,
  responseBody,
  endpointResponseId = null,
  started,
  payload,
}) {
  try {
    await logSvc.insertLog(req.db.stateless, {
      project_id: projectId ?? null,
      endpoint_id: originId ?? null,
      request_method: method,
      request_path: path,
      request_headers: req.headers || {},
      request_body: payload || {},
      response_status_code: status,
      response_body: responseBody,
      endpoint_response_id: endpointResponseId,
      ip_address: getClientIp(req),
      latency_ms: Date.now() - started,
    });
  } catch (e) {
    console.error("[statefulHandler] log error:", e?.message || e);
  }
}

// ============ Handler ============
module.exports = async function statefulHandler(req, res, next) {
  const started = Date.now();

  // ⚠️ Nhận meta từ universalHandler
  const meta = req.universal || {};
  const method = (meta.method || req.method || "GET").toUpperCase();
  const basePath = meta.basePath || req.path;     // VD: "/tree" hoặc "/tree/:id"
  const rawPath  = meta.rawPath  || req.originalUrl || req.path; // VD: "/tree/1" hoặc "/tree"
  const idInUrl  = meta.idInUrl;                  // number | null
  const hasId    = idInUrl != null;
  const idFromUrl = hasId ? Number(idInUrl) : undefined;

  // Lấy workspaceName & projectName từ baseUrl như logic cũ
  const baseSegs = (req.baseUrl || "").split("/").filter(Boolean);
  const workspaceName = baseSegs[0] || null;
  const projectName   = baseSegs[1] || null;

  // logicalPath (bỏ "/:id" nếu có trong basePath)
  const logicalPath = String(basePath || "").replace(/\/:id$/, "");

  if (!workspaceName || !projectName || !basePath) {
    const body = {
      message: "Full route required: /{workspaceName}/{projectName}/{path}",
      detail: { method, path: rawPath }
    };
    return res.status(400).json(body);
  }

  // statefulId/statelessId do universalHandler resolve sẵn
  const statefulId = meta.statefulId || null;
  let originId = meta.statelessId || null;
  let projectId = null;
  let isPublic = false;

  try {
    if (!statefulId) {
      const status = 404;
      const body = { message: "Endpoint not found", detail: { method, path: rawPath } };
      await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
        responseBody: body, started, payload: req.body });
      return res.status(status).json(body);
    }

    // --- Fetch endpoints_ful info (origin_id, folder_id) ---
    let folderId = null;
    {
      const efRow = await req.db.stateful.query(
        "SELECT origin_id, folder_id FROM endpoints_ful WHERE id = $1 LIMIT 1",
        [statefulId]
      );
      if (efRow.rows[0]) {
        originId = originId || efRow.rows[0].origin_id || null;
        folderId = efRow.rows[0].folder_id || null;
      }
      if (folderId) {
        const prj = await req.db.stateless.query(
          "SELECT project_id, is_public FROM folders WHERE id = $1 LIMIT 1",
          [folderId]
        );
        projectId = prj.rows[0]?.project_id ?? null;
        isPublic = Boolean(prj.rows[0]?.is_public);
      }
    }

    // --- Collection & data (giữ cách đặt tên cũ) ---
    const collectionName = (function () {
      const sanitize = (s) =>
        String(s ?? "").replace(/\u0000/g, "").replace(/^\.+|\.+$/g, "");
      const logicalRest = String(logicalPath || "").replace(/^\/+/, "");
      return `${sanitize(logicalRest)}.${sanitize(workspaceName)}.${sanitize(projectName)}`;
    })();
    const col = getCollection(collectionName);
    const doc = (await col.findOne({})) || { data_current: [], data_default: [] };
    const current = Array.isArray(doc.data_current)
      ? doc.data_current
      : doc.data_current ? [doc.data_current] : [];
    const defaults = Array.isArray(doc.data_default)
      ? doc.data_default
      : doc.data_default ? [doc.data_default] : [];

    // --- Endpoint schema ---
    const { rows: schRows } = await req.db.stateful.query(
      "SELECT schema FROM endpoints_ful WHERE id = $1 LIMIT 1",
      [statefulId]
    );
    const schema = normalizeJsonb(schRows?.[0]?.schema) || {};

    // --- Folder base_schema ---
    let baseSchema = {};
    if (folderId) {
      const { rows: baseRows } = await req.db.stateless.query(
        "SELECT base_schema FROM folders WHERE id = $1 LIMIT 1",
        [folderId]
      );
      baseSchema = normalizeJsonb(baseRows?.[0]?.base_schema) || {};
    }

    // --- Responses bucket ---
    const responsesBucket = await loadResponsesBucket(req.db.stateful, statefulId);

    // =================== GET ===================
    if (method === "GET") {
      const userIdMaybe = pickUserIdFromRequest(req);

      // Project theo fields: giữ key null nếu thiếu
      const pickForGET = (obj) => {
        const fieldsArray = Array.isArray(schema?.fields) ? schema.fields : [];
        if (fieldsArray.length === 0) {
          const { user_id, ...rest } = obj || {};
          return rest;
        }
        const out = {};
        for (const k of fieldsArray) {
          if (k === "user_id") continue;
          out[k] = Object.prototype.hasOwnProperty.call(obj || {}, k) ? obj[k] : null;
        }
        if (hasId && !fieldsArray.includes("id")) out.id = obj?.id ?? null;
        return out;
      };

      let currentScoped = [];
      if (isPublic) {
        currentScoped = userIdMaybe == null ? [] : current; // public, chưa login → không lấy current
      } else {
        currentScoped = userIdMaybe == null
          ? []
          : current.filter((x) => Number(x?.user_id) === Number(userIdMaybe));
      }

      if (hasId) {
        const foundCurrent = currentScoped.find((x) => Number(x?.id) === idFromUrl);
        if (foundCurrent) {
          const body = pickForGET(foundCurrent);
          await insertLogSafely(req, { projectId, originId, method, path: rawPath, status: 200,
            responseBody: body, endpointResponseId: null, started, payload: req.body });
          return res.status(200).json(body);
        }
        const foundDefault = defaults.find((x) => Number(x?.id) === idFromUrl);
        if (foundDefault) {
          const body = pickForGET(foundDefault);
          await insertLogSafely(req, { projectId, originId, method, path: rawPath, status: 200,
            responseBody: body, endpointResponseId: null, started, payload: req.body });
          return res.status(200).json(body);
        }

        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket, status, { params: { id: idFromUrl } },
          { fallback: { message: "{Path} with id {id} not found." }, requireParamId: true, paramsIdOccurrences: 1 }
        );
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
        return res.status(status).json(rendered);
      }

      const defaultsOut = defaults.map(pickForGET);
      const currentOut  = currentScoped.map(pickForGET);
      const combined = [...defaultsOut, ...currentOut];

      await insertLogSafely(req, { projectId, originId, method, path: rawPath, status: 200,
        responseBody: combined, endpointResponseId: null, started, payload: req.body });
      return res.status(200).json(combined);
    }

    // =================== POST ===================
    if (method === "POST") {
      // BẮT BUỘC đăng nhập (public/private đều vậy)
      const userId = requireAuth(req, res);
      if (userId == null) {
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status: 403,
          responseBody: { error: "Unauthorized: login required." }, endpointResponseId: null, started, payload: req.body });
        return;
      }

      const payload = req.body || {};
      const endpointSchema = schema || {};

      // Validate theo endpoint schema
      const { ok } = validateAndSanitizePayload(endpointSchema, payload, {
        allowMissingRequired: false,
        rejectUnknown: true,
      });
      if (!ok) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket, status, {},
          { fallback: { message: "Invalid data: request does not match {path} object schema." } }
        );
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload });
        return res.status(status).json(rendered);
      }

      // Union(base_schema ∪ endpointSchema)
      const unionKeys = Array.from(new Set([
        ...Object.keys(baseSchema || {}),
        ...Object.keys(endpointSchema || {}),
      ])).filter(k => k !== "user_id");

      // id rule
      const idRule = endpointSchema?.id || {};
      let newId = payload.id;
      if (idRule?.required === true && (newId === undefined || newId === null)) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket, status, {},
          { fallback: { message: "Invalid data: request does not match {path} object schema." } }
        );
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload });
        return res.status(status).json(rendered);
      }
      if (idRule?.required === false && (newId === undefined || newId === null)) {
        const maxId = current.reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0);
        newId = maxId + 1;
      }

      // conflict id
      if (newId !== undefined && current.some((x) => Number(x?.id) === Number(newId))) {
        const status = 409;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket, status, { params: { id: newId } },
          { fallback: { message: "{Path} {{params.id}} conflict: {{params.id}} already exists." },
            requireParamId: true, paramsIdOccurrences: 1 }
        );
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload });
        return res.status(status).json(rendered);
      }

      // Build object đầy đủ union field; thiếu thì ghi null
      const newObj = {};
      for (const k of unionKeys) {
        if (k === "id") continue;
        if (Object.prototype.hasOwnProperty.call(payload, k)) {
          newObj[k] = payload[k];
        } else {
          newObj[k] = null;
        }
      }
      newObj.id = newId;
      newObj.user_id = Number(userId);

      const updated = [...current, newObj];
      await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

      const status = 201;
      const { rendered, responseId } = selectAndRenderResponseAdv(
        responsesBucket, status, {},
        { fallback: { message: "New {path} item added successfully." } }
      );
      await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
        responseBody: rendered, endpointResponseId: responseId, started, payload });
      return res.status(status).json(rendered);
    }

    // =================== PUT ===================
    if (method === "PUT") {
      // BẮT BUỘC đăng nhập + đúng owner
      const userId = requireAuth(req, res);
      if (userId == null) {
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status: 403,
          responseBody: { error: "Unauthorized: login required." }, endpointResponseId: null, started, payload: req.body });
        return;
      }

      if (!hasId) {
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket, status, {},
          { fallback: { message: "Not found." }, requireParamId: false }
        );
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
        return res.status(status).json(rendered);
      }

      const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
      if (idx === -1) {
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket, status, { params: { id: idFromUrl } },
          { fallback: { message: "{Path} with id {{params.id}} not found." }, requireParamId: true, paramsIdOccurrences: 1 }
        );
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
        return res.status(status).json(rendered);
      }

      const ownerId = Number(current[idx]?.user_id);
      if (ownerId !== Number(userId)) {
        const status = 403;
        const body = { error: "Forbidden" };
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: body, endpointResponseId: null, started, payload: req.body });
        return res.status(status).json(body);
      }

      const payload = req.body || {};
      if (Object.prototype.hasOwnProperty.call(payload, "user_id")) delete payload.user_id;

      // Đổi id → check conflict
      const targetId = payload.id;
      if (targetId !== undefined && Number(targetId) !== idFromUrl) {
        const exists = current.some((x) => Number(x?.id) === Number(targetId));
        if (exists) {
          const status = 409;
          const { rendered, responseId } = selectAndRenderResponseAdv(
            responsesBucket, status, { params: { id: idFromUrl, id_conflict: Number(targetId) } },
            { fallback: { message: "Update id {{params.id}} conflict: {Path} id {{params.id}} in request body already exists." },
              requireParamId: true, paramsIdOccurrences: 2 }
          );
          await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
            responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
          return res.status(status).json(rendered);
        }
      }

      // Validate theo endpoint schema: thiếu required → 400; unknown → 400
      const { ok } = validateAndSanitizePayload(schema, payload, {
        allowMissingRequired: false,
        rejectUnknown: true,
      });
      if (!ok) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket, status, {},
          { fallback: { message: "Invalid data: request does not match {path} schema." } }
        );
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
        return res.status(status).json(rendered);
      }

      // Apply changes: field không gửi -> giữ nguyên
      const updatedItem = { ...current[idx], ...payload, user_id: ownerId };
      const updated = current.slice();
      updated[idx] = updatedItem;
      await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponseAdv(
        responsesBucket, status, { params: { id: idFromUrl } },
        { fallback: { message: "{Path} with id {{params.id}} updated successfully." },
          requireParamId: true, paramsIdOccurrences: 1 }
      );
      await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
        responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
      return res.status(status).json(rendered);
    }

    // =================== DELETE ===================
    if (method === "DELETE") {
      // BẮT BUỘC đăng nhập + đúng owner
      const userId = requireAuth(req, res);
      if (userId == null) {
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status: 403,
          responseBody: { error: "Unauthorized: login required." }, endpointResponseId: null, started, payload: req.body });
        return;
      }

      if (hasId) {
        const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
        if (idx === -1) {
          const status = 404;
          const { rendered, responseId } = selectAndRenderResponseAdv(
            responsesBucket, status, { params: { id: idFromUrl } },
            { fallback: { message: "{Path} with id {{params.id}} to delete not found." }, requireParamId: true, paramsIdOccurrences: 1 }
          );
          await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
            responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
          return res.status(status).json(rendered);
        }
        const ownerId = Number(current[idx]?.user_id);
        if (ownerId !== Number(userId)) {
          const status = 403;
          const body = { error: "Forbidden" };
          await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
            responseBody: body, endpointResponseId: null, started, payload: req.body });
          return res.status(status).json(body);
        }

        const updated = current.slice();
        updated.splice(idx, 1);
        await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

        const status = 200;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket, status, { params: { id: idFromUrl } },
          { fallback: { message: "{Path} with id {{params.id}} deleted successfully." }, requireParamId: true, paramsIdOccurrences: 1 }
        );
        await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
        return res.status(status).json(rendered);
      }

      // Xoá all: chỉ xoá của user hiện tại
      const keep = current.filter((x) => Number(x?.user_id) !== Number(userId));
      await col.updateOne({}, { $set: { data_current: keep } }, { upsert: true });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponseAdv(
        responsesBucket, status, {},
        { fallback: { message: "Delete all data with {Path} successfully." }, requireParamId: false, paramsIdOccurrences: 0 }
      );
      await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
        responseBody: rendered, endpointResponseId: responseId, started, payload: req.body });
      return res.status(status).json(rendered);
    }

    // =================== Method khác ===================
    {
      const status = 405;
      const body = { message: "Method Not Allowed" };
      await insertLogSafely(req, { projectId, originId, method, path: rawPath, status,
        responseBody: body, endpointResponseId: null, started, payload: req.body });
      return res.status(status).json(body);
    }
  } catch (err) {
    console.error("[statefulHandler] error:", err);
    const status = 500;
    const body = { message: "Internal Server Error", error: err.message };
    await insertLogSafely(req, {
      projectId: null,
      originId: null,
      method,
      path: rawPath,
      status,
      responseBody: body,
      endpointResponseId: null,
      started,
      payload: req.body,
    });
    return res.status(status).json(body);
  }
};
