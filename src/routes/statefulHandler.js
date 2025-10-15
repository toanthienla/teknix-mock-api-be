// statefulHandler.js
const { getCollection } = require("../config/db");
// const auth = require("../middlewares/authMiddleware"); // ❌ không dùng, bỏ để tránh nhầm
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

// --- URL helpers ---
function extractIdAndLookupPath(basePath) {
  const s = String(basePath || "");
  const m = s.match(/\/(\d+)(?:\/)?$/);
  if (m) {
    const idNum = Number(m[1]);
    const pathForLookup = s.replace(/\/\d+(?:\/)?$/, "/:id");
    const logicalPath   = s.replace(/\/\d+(?:\/)?$/, "");
    return { hasId: true, idFromUrl: idNum, pathForLookup, logicalPath };
  }
  return { hasId: false, idFromUrl: undefined, pathForLookup: s, logicalPath: s };
}
function buildPathCandidates({ pathForLookup, basePath, logicalPath }) {
  const norm = (p) => String(p || "").replace(/\/+$/, "") || "/";
  const withId = norm(pathForLookup);
  const base   = norm(basePath);
  const logic  = norm(logicalPath);
  const withoutId = norm(withId.replace(/\/:id$/, ""));
  const alsoBaseNoSlash = norm(basePath);
  const set = new Set([withId, base, logic, withoutId, alsoBaseNoSlash]);
  return Array.from(set).filter(Boolean);
}
async function resolveEndpointId(req, { method, workspaceName, projectName, candidates }) {
  const placeholders = candidates.map((_, i) => `$${i + 5}`).join(", ");
  const params1 = [method, workspaceName, projectName, candidates.length, ...candidates];
  const q1 = await req.db.stateless.query(
    `
    SELECT e.id AS origin_id, e.path
      FROM endpoints e
      JOIN folders f  ON f.id = e.folder_id
      JOIN projects p ON p.id = f.project_id
      JOIN workspaces w ON w.id = p.workspace_id
     WHERE UPPER(e.method) = $1
       AND w.name = $2
       AND p.name = $3
       AND e.path IN (${placeholders})
     ORDER BY 
       CASE e.path
         ${candidates.map((p, idx) => `WHEN $${idx + 5} THEN ${idx + 1}`).join(" ")}
         ELSE $4
       END ASC
     LIMIT 1
    `,
    params1
  );
  const originIdLocal = q1.rows?.[0]?.origin_id || null;
  if (!originIdLocal) return null;

  const params2 = [originIdLocal, method, candidates.length, ...candidates];
  const placeholders2 = candidates.map((_, i) => `$${i + 4}`).join(", ");
  const q2 = await req.db.stateful.query(
    `
    SELECT id, path
      FROM endpoints_ful
     WHERE origin_id = $1
       AND UPPER(method) = $2
       AND path IN (${placeholders2})
     ORDER BY 
       CASE path
         ${candidates.map((p, idx) => `WHEN $${idx + 4} THEN ${idx + 1}`).join(" ")}
         ELSE $3
       END ASC
     LIMIT 1
    `,
    params2
  );
  return q2.rows?.[0]?.id || null;
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
function pickResponseEntry(bucket, status, { requireParamId = null } = {}) {
  const arr = bucket.get(status) || [];
  if (arr.length === 0) return undefined;
  if (requireParamId === null) return arr[0];
  const hasParamToken = (entry) => {
    const s = typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
    return s.includes("{{params.id}}");
  };
  const withParam = arr.find(hasParamToken);
  const withoutParam = arr.find((x) => !hasParamToken(x));
  return requireParamId
    ? (withParam ?? withoutParam ?? arr[0])
    : (withoutParam ?? withParam ?? arr[0]);
}
function selectAndRenderResponse(bucket, status, ctx, { fallback, requireParamId } = {}) {
  const entry = pickResponseEntry(bucket, status, { requireParamId });
  const body = entry?.body ?? fallback ?? { message: `HTTP ${status}` };
  const rendered = renderTemplateDeep(normalizeJsonb(body), { ...(ctx || {}), status });
  return { rendered, responseId: entry?.id ?? null };
}

// ============ Auth & Schema ============
// Ưu tiên user từ JWT middleware; fallback header dev: x-mock-user-id
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
    res.status(401).json({ error: "Unauthorized" });
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
  const method = (req.method || "GET").toUpperCase();

  const baseSegs = (req.baseUrl || "").split("/").filter(Boolean);
  const workspaceName = baseSegs[0] || null;
  const projectName   = baseSegs[1] || null;
  const restPath      = (req.path || "").replace(/^\/+/, "");
  const basePath      = restPath ? `/${restPath}` : req.path;

  const { hasId, idFromUrl, pathForLookup, logicalPath } = extractIdAndLookupPath(basePath);

  if (!workspaceName || !projectName || !restPath) {
    const body = {
      message: "Full route required: /{workspaceName}/{projectName}/{path}",
      detail: { method, path: req.originalUrl || req.url }
    };
    return res.status(400).json(body);
  }

  let projectId = null, originId = null, isPublic = false;

  try {
    const candidates = buildPathCandidates({ pathForLookup, basePath, logicalPath });
    const endpointId =
      req.endpoint_stateful?.id ||
      (await resolveEndpointId(req, { method, workspaceName, projectName, candidates }));

    if (!endpointId) {
      const status = 404;
      const body = { message: "Endpoint not found", detail: { method, path: req.originalUrl || req.path, workspaceName, projectName, basePath: pathForLookup } };
      await insertLogSafely(req, {
        projectId, originId, method, path: req.path, status,
        responseBody: body, started, payload: req.body,
      });
      return res.status(status).json(body);
    }

    let folderId = null;
    {
      const efRow = await req.db.stateful.query(
        "SELECT origin_id, folder_id FROM endpoints_ful WHERE id = $1 LIMIT 1",
        [endpointId]
      );
      if (efRow.rows[0]) {
        originId = efRow.rows[0].origin_id || null;
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

    const { rows: schRows } = await req.db.stateful.query(
      "SELECT schema FROM endpoints_ful WHERE id = $1 LIMIT 1",
      [endpointId]
    );
    const schema = normalizeJsonb(schRows?.[0]?.schema) || {};

    const responsesBucket = await loadResponsesBucket(req.db.stateful, endpointId);

    // =================== GET ===================
    if (method === "GET") {
      const pickForGET = (obj) => {
        const fieldsArray = Array.isArray(schema?.fields) ? schema.fields : null;
        if (fieldsArray && fieldsArray.length > 0) {
          const set = new Set(fieldsArray);
          const out = {};
          for (const k of set) {
            if (k === "user_id") continue;
            if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
          }
          return out;
        }
        const keys = Object.keys(schema || {});
        if (keys.length === 0) {
          const { user_id, ...rest } = obj;
          return rest;
        }
        const set = new Set(keys);
        const out = {};
        for (const k of set) {
          if (k === "user_id") continue;
          if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
        }
        if (!set.has("user_id") && Object.prototype.hasOwnProperty.call(obj, "id")) {
          out.id = obj.id;
        }
        return out;
      };

      const defaultsOut = defaults.map(pickForGET);

      const userIdMaybe = pickUserIdFromRequest(req);
      const currentScoped = isPublic
        ? current
        : (userIdMaybe == null ? [] : current.filter((x) => Number(x?.user_id) === Number(userIdMaybe)));
      const currentOut = currentScoped.map(pickForGET);

      if (hasId) {
        const foundCurrent = currentScoped.find((x) => Number(x?.id) === idFromUrl);
        if (foundCurrent) {
          const body = pickForGET(foundCurrent);
          await insertLogSafely(req, {
            projectId, originId, method, path: req.path, status: 200,
            responseBody: body, endpointResponseId: null, started, payload: req.body,
          });
          return res.status(200).json(body);
        }
        const foundDefault = defaults.find((x) => Number(x?.id) === idFromUrl);
        if (foundDefault) {
          const body = pickForGET(foundDefault);
          await insertLogSafely(req, {
            projectId, originId, method, path: req.path, status: 200,
            responseBody: body, endpointResponseId: null, started, payload: req.body,
          });
          return res.status(200).json(body);
        }

        const status = 404;
        const { rendered, responseId } = selectAndRenderResponse(
          responsesBucket, status, { params: { id: idFromUrl } },
          { fallback: { message: "Not found." } }
        );
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body,
        });
        return res.status(status).json(rendered);
      }

      const combined = [...defaultsOut, ...currentOut];
      await insertLogSafely(req, {
        projectId, originId, method, path: req.path, status: 200,
        responseBody: combined, endpointResponseId: null, started, payload: req.body,
      });
      return res.status(200).json(combined);
    }

    // =================== POST ===================
    if (method === "POST") {
      // Private → bắt buộc auth; Public → cho phép, user_id=0 nếu không có auth
      let userId = pickUserIdFromRequest(req);
      if (userId == null) {
        if (isPublic) {
          userId = 0; // anonymous cho public collections (dev tiện)
        } else {
          userId = requireAuth(req, res);
          if (userId == null) {
            await insertLogSafely(req, {
              projectId, originId, method, path: req.path, status: 401,
              responseBody: { error: "Unauthorized" }, endpointResponseId: null, started, payload: req.body,
            });
            return;
          }
        }
      }

      const payload = req.body || {};
      const idRule = schema?.id || {};

      if (idRule?.required === true && (payload.id === undefined || payload.id === null)) {
        const status = 403;
        const { rendered, responseId } = selectAndRenderResponse(
          responsesBucket, status, {},
          { fallback: { message: "Invalid schema." } }
        );
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload
        });
        return res.status(status).json(rendered);
      }

      const { ok, errors, sanitized } = validateAndSanitizePayload(schema, payload, {
        allowMissingRequired: false, rejectUnknown: true,
      });
      if (!ok) {
        const status = 403;
        const { rendered, responseId } = selectAndRenderResponse(
          responsesBucket, status, {},
          { fallback: { message: "Invalid data: request does not match object schema." } }
        );
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload
        });
        return res.status(status).json(rendered);
      }

      let newId = sanitized.id;
      if (idRule?.required === false && (newId === undefined || newId === null)) {
        const maxId = current.reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0);
        newId = maxId + 1;
      }
      if (newId !== undefined && current.some((x) => Number(x?.id) === Number(newId))) {
        const status = 409;
        const { rendered, responseId } = selectAndRenderResponse(
          responsesBucket, status, { params: { id: newId } },
          { fallback: { message: "Conflict." } }
        );
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload
        });
        return res.status(status).json(rendered);
      }

      const newObj = { ...sanitized, id: newId, user_id: Number(userId) };
      const updated = [...current, newObj];
      await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

      const status = 201;
      const { rendered, responseId } = selectAndRenderResponse(
        responsesBucket, status, { params: { id: newId } },
        { fallback: { message: "Created." } }
      );
      await insertLogSafely(req, {
        projectId, originId, method, path: req.path, status,
        responseBody: rendered, endpointResponseId: responseId, started, payload
      });
      return res.status(status).json(rendered);
    }

    // =================== PUT ===================
    if (method === "PUT") {
      // Luôn cần định danh và đúng owner (kể cả public)
      let userId = pickUserIdFromRequest(req);
      if (userId == null) {
        userId = requireAuth(req, res);
        if (userId == null) {
          await insertLogSafely(req, {
            projectId, originId, method, path: req.path, status: 401,
            responseBody: { error: "Unauthorized" }, endpointResponseId: null, started, payload: req.body,
          });
          return;
        }
      }

      if (!hasId) {
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponse(
          responsesBucket, status, {},
          { fallback: { message: "Not found." } }
        );
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body
        });
        return res.status(status).json(rendered);
      }

      const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
      if (idx === -1) {
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponse(
          responsesBucket, status, { params: { id: idFromUrl } },
          { fallback: { message: "Not found." } }
        );
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body
        });
        return res.status(status).json(rendered);
      }

      const ownerId = Number(current[idx]?.user_id);
      if (ownerId !== Number(userId)) {
        const status = 403;
        const body = { error: "Forbidden" };
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: body, endpointResponseId: null, started, payload: req.body
        });
        return res.status(status).json(body);
      }

      const payload = req.body || {};
      if (Object.prototype.hasOwnProperty.call(payload, "user_id")) delete payload.user_id;

      const targetId = payload.id;
      if (targetId !== undefined && Number(targetId) !== idFromUrl) {
        const exists = current.some((x) => Number(x?.id) === Number(targetId));
        if (exists) {
          const status = 409;
          const { rendered, responseId } = selectAndRenderResponse(
            responsesBucket, status, { params: { id: idFromUrl, id_conflict: Number(targetId) } },
            { fallback: { message: "Conflict." } }
          );
          await insertLogSafely(req, {
            projectId, originId, method, path: req.path, status,
            responseBody: rendered, endpointResponseId: responseId, started, payload
          });
          return res.status(status).json(rendered);
        }
      }

      const { ok, errors, sanitized } = validateAndSanitizePayload(schema, payload, {
        allowMissingRequired: false, rejectUnknown: true,
      });
      if (!ok) {
        const status = 403;
        const { rendered, responseId } = selectAndRenderResponse(
          responsesBucket, status, {},
          { fallback: { message: "Invalid data: request does not match object schema." } }
        );
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload
        });
        return res.status(status).json(rendered);
      }

      const updatedItem = { ...current[idx], ...sanitized, user_id: ownerId };
      const updated = current.slice();
      updated[idx] = updatedItem;
      await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponse(
        responsesBucket, status, { params: { id: idFromUrl } },
        { fallback: { message: "Updated." } }
      );
      await insertLogSafely(req, {
        projectId, originId, method, path: req.path, status,
        responseBody: rendered, endpointResponseId: responseId, started, payload
      });
      return res.status(status).json(rendered);
    }

    // =================== DELETE ===================
    if (method === "DELETE") {
      // Luôn cần định danh và đúng owner
      let userId = pickUserIdFromRequest(req);
      if (userId == null) {
        userId = requireAuth(req, res);
        if (userId == null) {
          await insertLogSafely(req, {
            projectId, originId, method, path: req.path, status: 401,
            responseBody: { error: "Unauthorized" }, endpointResponseId: null, started, payload: req.body,
          });
          return;
        }
      }

      if (hasId) {
        const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
        if (idx === -1) {
          const status = 404;
          const { rendered, responseId } = selectAndRenderResponse(
            responsesBucket, status, { params: { id: idFromUrl } },
            { fallback: { message: "Not found." } }
          );
          await insertLogSafely(req, {
            projectId, originId, method, path: req.path, status,
            responseBody: rendered, endpointResponseId: responseId, started, payload: req.body
          });
          return res.status(status).json(rendered);
        }
        const ownerId = Number(current[idx]?.user_id);
        if (ownerId !== Number(userId)) {
          const status = 403;
          const body = { error: "Forbidden" };
          await insertLogSafely(req, {
            projectId, originId, method, path: req.path, status,
            responseBody: body, endpointResponseId: null, started, payload: req.body
          });
          return res.status(status).json(body);
        }

        const updated = current.slice();
        updated.splice(idx, 1);
        await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

        const status = 200;
        const { rendered, responseId } = selectAndRenderResponse(
          responsesBucket, status, { params: { id: idFromUrl } },
          { fallback: { message: "Deleted." }, requireParamId: true }
        );
        await insertLogSafely(req, {
          projectId, originId, method, path: req.path, status,
          responseBody: rendered, endpointResponseId: responseId, started, payload: req.body
        });
        return res.status(status).json(rendered);
      }

      // Xoá all: chỉ xoá của user hiện tại
      const keep = current.filter((x) => Number(x?.user_id) !== Number(userId));
      await col.updateOne({}, { $set: { data_current: keep } }, { upsert: true });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponse(
        responsesBucket, status, {},
        { fallback: { message: "Deleted all." }, requireParamId: false }
      );
      await insertLogSafely(req, {
        projectId, originId, method, path: req.path, status,
        responseBody: rendered, endpointResponseId: responseId, started, payload: req.body
      });
      return res.status(status).json(rendered);
    }

    // =================== Method khác ===================
    {
      const status = 405;
      const body = { message: "Method Not Allowed" };
      await insertLogSafely(req, {
        projectId, originId, method, path: req.path, status,
        responseBody: body, endpointResponseId: null, started, payload: req.body
      });
      return res.status(status).json(body);
    }
  } catch (err) {
    console.error("[statefulHandler] error:", err);
    const status = 500;
    const body = { message: "Internal Server Error", error: err.message };
    await insertLogSafely(req, {
      projectId: null,
      originId: null,
      method: (req.method || "GET").toUpperCase(),
      path: req.path,
      status,
      responseBody: body,
      endpointResponseId: null,
      started,
      payload: req.body,
    });
    return res.status(status).json(body);
  }
};
