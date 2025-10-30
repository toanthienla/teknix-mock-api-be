// src/routes/statefulHandler.js
const { getCollection } = require("../config/db");
const logSvc = require("../services/project_request_log.service");
const { onProjectLogInserted } = require("../services/notification.service");
const { runNextCalls, buildPlanFromAdvancedConfig } = require("./nextcallRouter");

/* ========== Utils ========== */
function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.connection?.remoteAddress || req.ip || null;
}
function normalizeJsonb(x) {
  if (x == null) return x;
  if (typeof x === "string") {
    try {
      return JSON.parse(x);
    } catch {
      return x;
    }
  }
  return x;
}
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}
function humanizePath(logicalPath) {
  const seg =
    String(logicalPath || "")
      .split("/")
      .filter(Boolean)
      .pop() || "";
  const lower = seg.toLowerCase();
  const title = lower.replace(/\b\w/g, (c) => c.toUpperCase());
  return { title, lower };
}
function expandStaticPlaceholders(str, logicalPath) {
  if (typeof str !== "string") return str;
  const h = humanizePath(logicalPath);
  return str.replace(/\{Path\}/g, h.title).replace(/\{path\}/g, h.lower);
}

/* ========== Helpers for nextCalls ========== */
// remove hepler parseTargetEndpoint

// remove hepler resolveEndpointForTenant

// remove hepler renderNextCallBody

// remove hepler createCaptureRes

/* ========== Template helpers ========== */
function getByPathSafe(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}
function renderTemplateWithOrderedParamsId(tpl, ctx) {
  if (typeof tpl !== "string") return tpl;
  if (ctx?.params && ctx.params.id_conflict != null) {
    let count = 0;
    let out = tpl.replace(/\{\{\s*params\.id\s*\}\}/g, () => {
      count += 1;
      return String(count === 1 ? ctx.params.id : ctx.params.id_conflict);
    });
    out = out.replace(/\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}/g, (_, path) => {
      if (path === "params.id") return "";
      const v = getByPathSafe(ctx, path);
      return v == null ? "" : String(v);
    });
    return out;
  }
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}/g, (_, path) => {
    const v = getByPathSafe(ctx, path);
    return v == null ? "" : String(v);
  });
}
function renderTemplateDeepOrdered(value, ctx) {
  if (typeof value === "string") return renderTemplateWithOrderedParamsId(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderTemplateDeepOrdered(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderTemplateDeepOrdered(v, ctx);
    return out;
  }
  return value;
}
function countParamsIdOccurrences(body) {
  const s = typeof body === "string" ? body : JSON.stringify(body || "");
  const m = s.match(/\{\{\s*params\.id\s*\}\}/g);
  return m ? m.length : 0;
}

/* ========== Responses bucket (STATEFUL DB) ========== */
async function loadResponsesBucket(statefulDb, endpointId) {
  const { rows } = await statefulDb.query(
    `SELECT id, status_code, response_body
       FROM endpoint_responses_ful
      WHERE endpoint_id = $1
      ORDER BY id ASC`,
    [endpointId]
  );
  const bucket = new Map();
  for (const r of rows) {
    const key = Number(r.status_code);
    const body = normalizeJsonb(r.response_body);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push({ id: Number(r.id), body });
  }
  return bucket;
}
function pickResponseEntryAdv(bucket, status, { requireParamId = null, paramsIdOccurrences = null } = {}) {
  const arr = bucket.get(status) || [];
  if (arr.length === 0) return undefined;

  let candidates = arr;
  if (requireParamId === true) candidates = candidates.filter((e) => countParamsIdOccurrences(e.body) >= 1);
  else if (requireParamId === false) candidates = candidates.filter((e) => countParamsIdOccurrences(e.body) === 0);
  if (paramsIdOccurrences != null) {
    const exact = candidates.filter((e) => countParamsIdOccurrences(e.body) === paramsIdOccurrences);
    if (exact.length) candidates = exact;
  }
  return candidates[0] || arr[0];
}
function pickAnyResponseEntry(bucket) {
  for (const [, list] of bucket.entries()) {
    if (list && list.length) return list[0];
  }
  return undefined;
}
/** Trả về { rendered, responseId } */
function selectAndRenderResponseAdv(bucket, status, ctx, { fallback, requireParamId, paramsIdOccurrences, logicalPath } = {}) {
  let entry = pickResponseEntryAdv(bucket, status, { requireParamId, paramsIdOccurrences });
  const found = !!entry;
  const raw = entry?.body ?? fallback ?? { message: `HTTP ${status}` };
  if (!found && !entry) {
    const any = pickAnyResponseEntry(bucket);
    if (any) entry = any; // dùng id để log nếu có
  }
  let rendered;
  if (typeof raw === "string") {
    rendered = renderTemplateWithOrderedParamsId(raw, ctx);
    rendered = expandStaticPlaceholders(rendered, logicalPath);
  } else {
    const tmp = renderTemplateDeepOrdered(normalizeJsonb(raw), ctx);
    try {
      rendered = JSON.parse(expandStaticPlaceholders(JSON.stringify(tmp), logicalPath));
    } catch {
      rendered = tmp;
    }
  }
  return { rendered, responseId: entry?.id ?? null };
}

/* ========== Auth/Schema ========== */
function pickUserIdFromRequest(req) {
  // Try a few places in a robust, case-insensitive way.
  const localsUser = req?.res?.locals?.user;

  // helper to read header case-insensitively and via req.get if available
  const getHeader = (key) => {
    if (!req) return undefined;
    if (typeof req.get === "function") {
      try {
        const v = req.get(key);
        if (v != null) return v;
      } catch { }
    }
    const h = req.headers || {};
    // try common variants
    return h[key] ?? h[key.toLowerCase()] ?? h[key.toUpperCase()] ?? undefined;
  };

  const headerVal = getHeader("x-mock-user-id") ?? getHeader("X-Mock-User-Id");

  const candidate = req?.user?.id ?? req?.user?.user_id ?? localsUser?.id ?? localsUser?.user_id ?? (headerVal != null ? headerVal : null);

  // normalize to number if possible
  if (candidate == null) return null;
  const n = Number(candidate);
  return Number.isFinite(n) ? n : null;
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

  const t = typeof expected === "string" ? expected.toLowerCase() : expected;

  const allowed = new Set(["number", "string", "boolean", "object", "array"]);
  if (!allowed.has(t)) {
    // nếu schema không khai báo type hoặc type sai -> KHÔNG cho pass
    return false;
  }

  if (t === "number") return typeof value === "number" && !Number.isNaN(value);
  if (t === "integer") return typeof value === "number" && Number.isInteger(value); // 👈 thêm dòng này
  if (t === "string") return typeof value === "string" && value.trim() !== "";
  if (t === "boolean") return typeof value === "boolean";
  if (t === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (t === "array") return Array.isArray(value);

  return false;
}

function validateAndSanitizePayload(schema, payload, { allowMissingRequired = false, rejectUnknown = true }) {
  const errors = [];
  const sanitized = {};
  const schemaFields = Object.keys(schema || {});

  if (rejectUnknown) {
    const unknown = Object.keys(payload || {}).filter((k) => !schemaFields.includes(k) && k !== "user_id");
    if (unknown.length) errors.push(`Unknown fields: ${unknown.join(", ")}`);
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
    if (has && val !== null && val !== undefined) sanitized[key] = val;
  }
  if (schemaFields.includes("id") && payload.id !== undefined) sanitized.id = payload.id;
  return { ok: errors.length === 0, errors, sanitized };
}

/* ========== Resolve ResponseId bảo đảm có id để log ========== */
async function resolveStatefulResponseId(statefulDb, statefulId, providedId) {
  if (providedId != null) return providedId;
  if (statefulId == null) return null;
  try {
    const r = await statefulDb.query("SELECT id FROM endpoint_responses_ful WHERE endpoint_id = $1 ORDER BY id ASC LIMIT 1", [statefulId]);
    return r.rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/* ========== Logging (ghi vào DB stateless) ========== */
async function logWithStatefulResponse(req, { projectId, originId, statefulId, method, path, status, responseBody, started, payload, statefulResponseId = null }) {
  try {
    // 🆕 gắn user vào log nếu có (lấy từ auth hoặc header X-Mock-User-Id)
    const userIdForLog = pickUserIdFromRequest(req);
    const finalResponseId = await resolveStatefulResponseId(req.db.stateful, statefulId, statefulResponseId);
    const _log = await logSvc.insertLog(req.db.stateless, {
      project_id: projectId ?? null,
      endpoint_id: originId ?? null, // stateless endpoints.id
      endpoint_response_id: null, // NULL trong flow stateful
      stateful_endpoint_id: statefulId ?? null, // endpoints_ful.id (no FK)
      user_id: userIdForLog ?? null, // 🆕 thêm user_id để notify/trace theo user
      stateful_endpoint_response_id: finalResponseId ?? null, // endpoint_responses_ful.id (no FK)
      request_method: method,
      request_path: path,
      request_headers: req.headers || {},
      request_body: payload || {},
      response_status_code: status,
      response_body: responseBody,
      ip_address: getClientIp(req),
      latency_ms: Date.now() - started,
    });
    // 🆕 gọi hook notify sau khi có logId (fallback nếu service không trả id)
    let logId = _log && _log.id;
    if (!logId) {
      try {
        const r = await req.db.stateless.query(`SELECT id FROM project_request_logs ORDER BY id DESC LIMIT 1`);
        logId = r.rows?.[0]?.id || null;
        console.log("[stateful] fallback logId =", logId);
      } catch (e) {
        console.error("[stateful] fallback query failed:", e?.message || e);
      }
    }
    if (logId) {
      // expose logId cho caller (để nextCall dùng làm parent_log_id)
      try {
        req.res = req.res || {};
        req.res.locals = req.res.locals || {};
        req.res.locals.lastLogId = logId;
      } catch { }
      try {
        await onProjectLogInserted(logId, req.db.stateless);
      } catch (e) {
        console.error("[notify hook error]", e?.message || e);
      }
    } else {
      console.warn("[stateful] missing logId - skip notify");
    }
  } catch (e) {
    console.error("[statefulHandler] log error:", e?.message || e);
  }
}

/* ========== Mongo helpers ========== */
function buildCollectionName(logicalPath, workspaceName, projectName) {
  const sanitize = (s) =>
    String(s ?? "")
      .replace(/\u0000/g, "")
      .replace(/^\.+|\.+$/g, "");
  const logicalRest = String(logicalPath || "").replace(/^\/+/, "");
  return `${sanitize(logicalRest)}.${sanitize(workspaceName)}.${sanitize(projectName)}`;
}
async function loadInitializedDoc(col) {
  const seeded = await col.findOne({ data_current: { $exists: true } });
  if (seeded) return seeded;
  return null;
}

// remove hepler splitTargetEndpoint

/* ========== MAIN ========== */
async function statefulHandler(req, res, next) {
  const started = Date.now();

  // --- DEBUG: in thông tin request để kiểm tra nextCall nội bộ ---
  try {
    console.log("[statefulHandler:debug] method=", req.method, "originalUrl=", req.originalUrl || req.url);
    console.log("[statefulHandler:debug] universal=", JSON.stringify(req.universal || {}));
    console.log("[statefulHandler:debug] flags=", JSON.stringify(req.flags || {}));
    // Avoid huge logs: print concise headers (x-mock-user-id, content-type) and user
    const hdr = req.headers || {};
    console.log("[statefulHandler:debug] headers.x-mock-user-id=", hdr["x-mock-user-id"] ?? hdr["X-Mock-User-Id"] ?? null, "content-type=", hdr["content-type"] ?? hdr["Content-Type"] ?? null);
    console.log("[statefulHandler:debug] req.user=", JSON.stringify(req.user || null));
    // print body (safe stringify)
    try {
      console.log("[statefulHandler:debug] body=", typeof req.body === "object" ? JSON.stringify(req.body) : String(req.body));
    } catch (e) {
      console.log("[statefulHandler:debug] body= <unstringifiable>");
    }
  } catch (e) {
    console.warn("[statefulHandler:debug] error printing debug info:", e?.message || e);
  }
  // --- end debug ---

  const meta = req.universal || {};
  const method = (meta.method || req.method || "GET").toUpperCase();
  const basePath = meta.basePath || req.path;
  const rawPath = meta.rawPath || req.originalUrl || req.path;
  const idInUrl = meta.idInUrl;
  const hasId = idInUrl != null;
  const idFromUrl = hasId ? Number(idInUrl) : undefined;
  const logicalPath = String(basePath || "").replace(/\/:id$/, "");


  const baseSegs = (req.baseUrl || "").split("/").filter(Boolean);
  const workspaceName = baseSegs[0] || null;
  const projectName = baseSegs[1] || null;

  // Vars for selected endpoint / tenant
  let statefulId = null;
  let originId = null;
  let folderId = null;
  let projectId = null;
  let isPublic = false;

  // nextCall flags
  const isNextCall = req.flags?.isNextCall === true;
  const suppressNextCalls = req.flags?.suppressNextCalls === true;
  let advancedConfig = null; // sẽ được nạp lúc đọc endpoints_ful

  if (!workspaceName || !projectName || !basePath) {
    console.warn("[nextCalls] skip: missing full route prefix /:workspace/:project");
    const status = 400;
    const body = { message: "Full route required: /{workspaceName}/{projectName}/{path}", detail: { method, path: rawPath } };
    await logWithStatefulResponse(req, { projectId: null, originId: null, statefulId: null, method, path: rawPath, status, responseBody: body, started, payload: req.body, statefulResponseId: null });
    res.status(status).json(body);
    fireNextCallsIfAny(status, body);
    return;
  }

  // (Removed) nextCalls chain: no res wrappers, no capture/forward logic.

  // 👉 Helper: sau khi trả response chính thì mới bắn nextCalls (fire-and-forget)
  // 👉 Helper: sau khi trả response chính thì mới bắn nextCalls (fire-and-forget)
  function fireNextCallsIfAny(status, body, insertedLogId) {
    try {
      if (isNextCall || suppressNextCalls) return;
      if (!advancedConfig?.nextCalls?.length) return;
      const parentId = insertedLogId ?? req.res?.locals?.lastLogId ?? null;

      // Build root context compatible with nextcallRouter.renderTemplate
      const rootCtx = {
        req, // original express request (so templates can access req.headers, req.query, etc.)
        // compact request object so templates can use {{request.body.xxx}}
        request: {
          body: req?.body ?? {},
          headers: req?.headers ?? {},
          params: req?.params ?? {},
          query: req?.query ?? {},
        },
        // response available for templates as {{response.body...}}
        res: { status, body },
        workspaceName,
        projectName,
        user: req.user ?? null,
        log: { id: parentId },
        flags: { suppressNextCalls: false },
      };

      const plan = buildPlanFromAdvancedConfig(advancedConfig.nextCalls);
      console.log(
        `[nextCalls] scheduling chain (count = ${advancedConfig.nextCalls.length}) for ${workspaceName}/${projectName}${logicalPath} status = ${status}`
      );

      // fire-and-forget but pass DB + user so nextcallRouter can resolve auth/mapping
      runNextCalls(plan, rootCtx, {
        statefulDb: req.db.stateful,
        statelessDb: req.db.stateless,
        user: req.user,
      }).catch((err) => {
        console.error("[statefulHandler] runNextCalls async error:", err?.message || err);
      });
    } catch (err) {
      console.error("[statefulHandler] fireNextCallsIfAny error:", err?.message || err);
    }
  }


  try {
    /* 1) RÀNG BUỘC & RESOLVE endpoint theo workspace + project + method + path (đúng DB) */
    {
      const wantedMethod = method;
      const wantedPath = logicalPath;

      // 1a) Tìm ứng viên theo method+path ở STATEFUL
      const qEf = await req.db.stateful.query(
        `SELECT id, origin_id, folder_id
           FROM endpoints_ful
          WHERE is_active = TRUE
            AND method    = $1
            AND path      = $2
          ORDER BY id ASC`,
        [wantedMethod, wantedPath]
      );
      if (!qEf.rows.length) {
        const status = 404;
        const body = {
          message: "Endpoint not found for this method/path",
          detail: { method: wantedMethod, path: wantedPath },
        };
        await logWithStatefulResponse(req, { projectId: null, originId: null, statefulId: null, method, path: rawPath, status, responseBody: body, started, payload: req.body });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      // 1b) Lọc theo tenant ở STATELESS bằng folder_id
      const candidateFolderIds = qEf.rows.map((r) => Number(r.folder_id)).filter(Boolean);
      const qFold = await req.db.stateless.query(
        `SELECT f.id AS folder_id, f.is_public, p.id AS project_id, p.name AS project_name, w.name AS workspace_name
           FROM folders f
           JOIN projects  p ON p.id = f.project_id
           JOIN workspaces w ON w.id = p.workspace_id
          WHERE f.id = ANY($1::int[])`,
        [candidateFolderIds]
      );
      // Tìm folder khớp ws+pr
      const match = qFold.rows.find((r) => String(r.workspace_name || "").toLowerCase() === String(workspaceName).toLowerCase() && String(r.project_name || "").toLowerCase() === String(projectName).toLowerCase());
      if (!match) {
        const status = 404;
        const body = {
          message: "Endpoint not found for this workspace/project",
          detail: { workspaceName, projectName, method: wantedMethod, path: wantedPath },
        };
        await logWithStatefulResponse(req, { projectId: null, originId: null, statefulId: null, method, path: rawPath, status, responseBody: body, started, payload: req.body });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      // 1c) Chọn endpoint ứng với folder khớp
      const chosen = qEf.rows.find((r) => Number(r.folder_id) === Number(match.folder_id));
      if (!chosen) {
        const status = 404;
        const body = {
          message: "Endpoint mapping mismatch (folder not linked)",
          detail: { folderId: match.folder_id, method: wantedMethod, path: wantedPath },
        };
        await logWithStatefulResponse(req, { projectId: null, originId: null, statefulId: null, method, path: rawPath, status, responseBody: body, started, payload: req.body });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      // Bind đúng tenant
      statefulId = Number(chosen.id);
      originId = Number(chosen.origin_id);
      folderId = Number(chosen.folder_id);
      projectId = Number(match.project_id);
      isPublic = !!match.is_public;
    }

    /* 3) LOAD MONGO DOC */
    const collectionName = buildCollectionName(logicalPath, workspaceName, projectName);
    const col = getCollection(collectionName);
    const doc = await loadInitializedDoc(col);
    if (!doc) {
      const status = 404;
      const body = { message: `Collection ${collectionName} is not initialized (missing seeded document).` };
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
      res.status(status).json(body);
      fireNextCallsIfAny(status, body);
      return;
    }
    const docId = doc._id;
    const current = Array.isArray(doc.data_current) ? doc.data_current : doc.data_current ? [doc.data_current] : [];

    // 4) LOAD SCHEMA ở DB STATEFUL (không còn đọc/khởi tạo nextCalls/advanced_config)
    // 4) LOAD SCHEMA + ADVANCED_CONFIG ở DB STATEFUL
    let endpointSchemaDb = {};
    if (statefulId != null) {
      const { rows: schRows } = await req.db.stateful.query("SELECT schema, advanced_config FROM endpoints_ful WHERE id = $1 LIMIT 1", [statefulId]);
      endpointSchemaDb = normalizeJsonb(schRows?.[0]?.schema) || {};
      advancedConfig = normalizeJsonb(schRows?.[0]?.advanced_config) || null;
      const __cnt = Array.isArray(advancedConfig?.nextCalls) ? advancedConfig.nextCalls.length : 0;
      console.log(`[nextCalls] loaded for endpoint ${statefulId} count = ${__cnt}`);
    }

    // 5) BASE SCHEMA ở DB STATELESS (theo folderId)
    let baseSchema = {};
    if (folderId != null) {
      const { rows: baseRows } = await req.db.stateless.query("SELECT base_schema FROM folders WHERE id = $1 LIMIT 1", [folderId]);
      baseSchema = normalizeJsonb(baseRows?.[0]?.base_schema) || {};
    }

    // Ưu tiên schema của endpoint, fallback về base_schema
    const effectiveSchema = endpointSchemaDb && Object.keys(endpointSchemaDb).length ? endpointSchemaDb : baseSchema;

    // Nếu vẫn không có schema → chặn ghi
    if (!effectiveSchema || !Object.keys(effectiveSchema).length) {
      const status = 400;
      const body = { message: "Schema is not initialized for this endpoint/folder." };
      await logWithStatefulResponse(req, {
        projectId,
        originId,
        statefulId,
        method,
        path: rawPath,
        status,
        responseBody: body,
        started,
        payload: req.body,
      });
      res.status(status).json(body);
      fireNextCallsIfAny(status, body);
      return;
    }

    /* 6) LOAD RESPONSE BUCKET Ở DB STATEFUL */
    const responsesBucket = await loadResponsesBucket(req.db.stateful, statefulId);
    /* ===== GET ===== */
    if (method === "GET") {
      const userIdMaybe = pickUserIdFromRequest(req);

      const pickForGET = (obj) => {
        const fields = Array.isArray(effectiveSchema?.fields) ? effectiveSchema.fields : Object.keys(effectiveSchema || {});
        if (fields.length === 0) {
          const { user_id, ...rest } = obj || {};
          return rest;
        }
        const out = {};
        for (const k of fields) {
          if (k === "user_id") continue;
          out[k] = Object.prototype.hasOwnProperty.call(obj || {}, k) ? obj[k] : null;
        }
        return out;
      };

      // ---------- PUBLIC ----------
      if (isPublic) {
        // GET by ID
        if (hasId) {
          const any = current.find((x) => Number(x?.id) === Number(idFromUrl));
          if (any) {
            const data = pickForGET(any);
            const status = 200;
            const body = {
              code: status,
              message: "Success",
              data,
              success: true,
            };
            await logWithStatefulResponse(req, {
              projectId,
              originId,
              statefulId,
              method,
              path: rawPath,
              status,
              responseBody: body,
              started,
              payload: req.body,
            });
            res.status(status).json(body);
            fireNextCallsIfAny(status, body);
            return;
          }
          // Not found
          const status = 404;
          const { rendered, responseId } = selectAndRenderResponseAdv(
            responsesBucket,
            status,
            { params: { id: idFromUrl } },
            {
              fallback: { message: "{Path} with id {{params.id}} not found." },
              requireParamId: true,
              paramsIdOccurrences: 1,
              logicalPath,
            }
          );
          const body = {
            code: status,
            message: rendered?.message ?? `{Path} with id ${idFromUrl} not found.`,
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload: req.body,
            statefulResponseId: responseId,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }

        // GET all
        const all = current.map(pickForGET);
        const status = 200;
        const body = {
          code: status,
          message: "Success",
          data: all,
          success: true,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      // ---------- PRIVATE ----------
      if (hasId) {
        const uid = pickUserIdFromRequest(req);
        const rec = current.find((x) => Number(x?.id) === Number(idFromUrl));
        const allowed = rec && (rec.user_id == null || (uid != null && Number(rec.user_id) === Number(uid)));
        if (allowed) {
          const data = pickForGET(rec);
          const status = 200;
          const body = {
            code: status,
            message: "Success",
            data,
            success: true,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload: req.body,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }

        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          { params: { id: idFromUrl } },
          {
            fallback: { message: "{Path} with id {{params.id}} not found." },
            requireParamId: true,
            paramsIdOccurrences: 1,
            logicalPath,
          }
        );
        const body = {
          code: status,
          message: rendered?.message ?? `{Path} with id ${idFromUrl} not found.`,
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
          statefulResponseId: responseId,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      // GET all for private user
      const uid = pickUserIdFromRequest(req);
      const defaults = current.filter((x) => x.user_id == null || x.user_id === undefined).map(pickForGET);
      const mine = uid == null ? [] : current.filter((x) => Number(x?.user_id) === Number(uid)).map(pickForGET);

      const data = [...defaults, ...mine];
      const status = 200;
      const body = {
        code: status,
        message: "Success",
        data,
        success: true,
      };
      await logWithStatefulResponse(req, {
        projectId,
        originId,
        statefulId,
        method,
        path: rawPath,
        status,
        responseBody: body,
        started,
        payload: req.body,
      });
      res.status(status).json(body);
      fireNextCallsIfAny(status, body);
      return;
    }

    /* ===== POST ===== */
    if (method === "POST") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      const mongoDb = col.s.db;
      const exists = (await mongoDb.listCollections({ name: collectionName }).toArray()).some((c) => c.name === collectionName);
      if (!exists || !docId) {
        const status = 404;
        const body = {
          code: status,
          message: `Collection ${collectionName} is not initialized (missing seeded document).`,
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      const payload = req.body || {};

      // 🔧 Auto convert numeric-like strings & boolean strings before validation
      for (const [key, val] of Object.entries(payload)) {
        if (typeof val === "string") {
          if (/^[0-9]+$/.test(val)) {
            payload[key] = Number(val);
          } else if (/^(true|false)$/i.test(val)) {
            payload[key] = val.toLowerCase() === "true";
          }
        }
      }

      const endpointSchemaEffective =
        endpointSchemaDb && Object.keys(endpointSchemaDb).length
          ? endpointSchemaDb
          : baseSchema || {};

      // Kiểm tra thứ tự và hợp lệ schema
      const schemaKeys = Object.keys(endpointSchemaEffective);
      const payloadKeys = Object.keys(payload);
      let lastIndex = -1;
      for (const k of payloadKeys) {
        const idxKey = schemaKeys.indexOf(k);
        if (idxKey === -1) {
          const status = 400;
          const body = {
            code: status,
            message: `Invalid data: unknown field '${k}'.`,
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
        if (idxKey <= lastIndex) {
          const status = 400;
          const body = {
            code: status,
            message: "Invalid data: field order does not follow schema.",
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
        lastIndex = idxKey;
      }

      // Kiểm tra required + type
      for (const [k, rule] of Object.entries(endpointSchemaEffective)) {
        const hasValue = Object.prototype.hasOwnProperty.call(payload, k);
        const v = payload[k];
        if (rule.required === true && !hasValue) {
          const status = 400;
          const body = {
            code: status,
            message: `Missing required field: ${k}`,
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
        if (hasValue && v !== null && v !== undefined && !isTypeOK(rule.type, v)) {
          const status = 400;
          const body = {
            code: status,
            message: `Invalid type for ${k}: expected ${rule.type}`,
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
      }

      // Sinh id tự động hoặc kiểm tra id tồn tại
      const idRule = endpointSchemaEffective?.id || {};
      let newId = payload.id;
      if (idRule?.required === true && (newId === undefined || newId === null)) {
        const status = 400;
        const body = {
          code: status,
          message: "Invalid data: missing required field: id",
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      if ((idRule?.required === false || idRule?.required === undefined) && (newId === undefined || newId === null)) {
        const numericIds = current.map((x) => Number(x?.id)).filter((n) => Number.isFinite(n) && n >= 0);
        const maxId = numericIds.length ? Math.max(...numericIds) : 0;
        newId = maxId + 1;
      }

      if (newId !== undefined && typeof newId !== "number") {
        const status = 400;
        const body = {
          code: status,
          message: "Invalid data: id must be a number.",
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      if (newId !== undefined && current.some((x) => Number(x?.id) === Number(newId))) {
        const status = 409;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          { params: { id: newId } },
          {
            fallback: { message: "{Path} {{params.id}} conflict: {{params.id}} already exists." },
            requireParamId: true,
            paramsIdOccurrences: 1,
            logicalPath,
          }
        );
        const body = {
          code: status,
          message: rendered?.message ?? `{Path} ${newId} conflict: already exists.`,
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload,
          statefulResponseId: responseId,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      // Thêm mới item
      const baseKeys = Object.keys(baseSchema || {});
      const schemaKeysForInsert = Object.keys(endpointSchemaEffective);
      const unionKeys = Array.from(new Set([...baseKeys, ...schemaKeysForInsert])).filter((k) => k !== "user_id");

      const newObj = {};
      for (const k of unionKeys) {
        if (k === "id") newObj.id = newId;
        else if (Object.prototype.hasOwnProperty.call(payload, k)) newObj[k] = payload[k];
        else newObj[k] = null;
      }
      newObj.user_id = Number(userId);

      const updated = [...current, newObj];
      await col.updateOne({ _id: docId }, { $set: { data_current: updated } }, { upsert: false });

      const status = 201;
      const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "New {path} item added successfully." }, logicalPath });
      const body = {
        code: status,
        message: rendered?.message ?? "New item added successfully.",
        data: newObj,
        success: true,
      };
      await logWithStatefulResponse(req, {
        projectId,
        originId,
        statefulId,
        method,
        path: rawPath,
        status,
        responseBody: body,
        started,
        payload: req.body,
        statefulResponseId: responseId,
      });
      res.status(status).json(body);
      fireNextCallsIfAny(status, body);
      return;
    }

    /* ===== PUT ===== */
    if (method === "PUT") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      const mongoDb = col.s.db;
      const exists = (await mongoDb.listCollections({ name: collectionName }).toArray()).some((c) => c.name === collectionName);
      if (!exists || !docId) {
        const status = 404;
        const body = {
          code: status,
          message: `Collection ${collectionName} is not initialized (missing seeded document).`,
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      if (!hasId) {
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          {},
          {
            fallback: { message: "Not found." },
            requireParamId: false,
            logicalPath,
          }
        );
        const body = {
          code: status,
          message: rendered?.message ?? "Not found.",
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
          statefulResponseId: responseId,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      const idx = current.findIndex((x) => Number(x?.id) === Number(idFromUrl));
      if (idx === -1) {
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          { params: { id: idFromUrl } },
          {
            fallback: { message: "{Path} with id {{params.id}} not found." },
            requireParamId: true,
            paramsIdOccurrences: 1,
            logicalPath,
          }
        );
        const body = {
          code: status,
          message: rendered?.message ?? `{Path} with id ${idFromUrl} not found.`,
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
          statefulResponseId: responseId,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      // owner check
      const rawOwner = current[idx]?.user_id;
      const ownerId = rawOwner == null ? null : Number(rawOwner);
      if (ownerId !== null && ownerId !== Number(userId)) {
        const status = 403;
        const body = {
          code: status,
          message: "You are not the author of this object.",
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      let payload = req.body || {};
      if (Object.prototype.hasOwnProperty.call(payload, "user_id")) delete payload.user_id;

      const endpointSchemaEffective = endpointSchemaDb && Object.keys(endpointSchemaDb).length ? endpointSchemaDb : baseSchema || {};

      // Order & type checks
      const schemaKeys = Object.keys(endpointSchemaEffective);
      const payloadKeys = Object.keys(payload);
      let lastIndex = -1;
      for (const k of payloadKeys) {
        const idxSchema = schemaKeys.indexOf(k);
        if (idxSchema === -1) {
          const status = 400;
          const body = {
            code: status,
            message: `Invalid data: unknown field '${k}'.`,
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
        if (idxSchema <= lastIndex) {
          const status = 400;
          const body = {
            code: status,
            message: "Invalid data: field order does not follow schema.",
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
        lastIndex = idxSchema;
      }

      for (const [k, rule] of Object.entries(endpointSchemaEffective)) {
        const hasValue = Object.prototype.hasOwnProperty.call(payload, k);
        const v = payload[k];
        if (rule.required === true && !hasValue) {
          const status = 400;
          const body = {
            code: status,
            message: `Missing required field: ${k}`,
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
        if (hasValue && v !== null && v !== undefined && !isTypeOK(rule.type, v)) {
          const status = 400;
          const body = {
            code: status,
            message: `Invalid type for ${k}: expected ${rule.type}`,
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
      }

      // Update data
      const schemaKeysForUpdate = Object.keys(endpointSchemaEffective);
      const extraKeys = Object.keys(current[idx] || {}).filter((k) => !schemaKeysForUpdate.includes(k) && k !== "user_id");
      const updateOrder = [...schemaKeysForUpdate, ...extraKeys];
      const updatedItem = {};

      for (const k of updateOrder) {
        if (k === "id") {
          updatedItem.id = idFromUrl;
        } else if (Object.prototype.hasOwnProperty.call(payload, k)) {
          updatedItem[k] = payload[k];
        } else {
          updatedItem[k] = current[idx]?.[k] ?? null;
        }
      }

      updatedItem.user_id = ownerId === null ? Number(userId) : ownerId;
      const updated = current.slice();
      updated[idx] = updatedItem;
      await col.updateOne({ _id: docId }, { $set: { data_current: updated } }, { upsert: false });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponseAdv(
        responsesBucket,
        status,
        { params: { id: idFromUrl } },
        {
          fallback: { message: "{Path} with id {{params.id}} updated successfully." },
          requireParamId: true,
          paramsIdOccurrences: 1,
          logicalPath,
        }
      );
      const body = {
        code: status,
        message: rendered?.message ?? "Update success.",
        data: updatedItem,
        success: true,
      };
      await logWithStatefulResponse(req, {
        projectId,
        originId,
        statefulId,
        method,
        path: rawPath,
        status,
        responseBody: body,
        started,
        payload: req.body,
        statefulResponseId: responseId,
      });
      res.status(status).json(body);
      fireNextCallsIfAny(status, body);
      return;
    }

    /* ===== DELETE ===== */
    if (method === "DELETE") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      const mongoDb = col.s.db;
      const exists = (await mongoDb.listCollections({ name: collectionName }).toArray()).some((c) => c.name === collectionName);
      if (!exists || !docId) {
        const status = 404;
        const body = {
          code: status,
          message: `Collection ${collectionName} is not initialized (missing seeded document).`,
          data: null,
          success: false,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      if (hasId) {
        const idx = current.findIndex((x) => Number(x?.id) === Number(idFromUrl));
        if (idx === -1) {
          const status = 404;
          const { rendered, responseId } = selectAndRenderResponseAdv(
            responsesBucket,
            status,
            { params: { id: idFromUrl } },
            {
              fallback: { message: "{Path} with id {{params.id}} to delete not found." },
              requireParamId: true,
              paramsIdOccurrences: 1,
              logicalPath,
            }
          );
          const body = {
            code: status,
            message: rendered?.message ?? `{Path} with id ${idFromUrl} not found.`,
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload: req.body,
            statefulResponseId: responseId,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }

        const ownerId = Number(current[idx]?.user_id);
        if (ownerId !== Number(userId)) {
          const status = 403;
          const body = {
            code: status,
            message: "You are not the author of this object.",
            data: null,
            success: false,
          };
          await logWithStatefulResponse(req, {
            projectId,
            originId,
            statefulId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            started,
            payload: req.body,
          });
          res.status(status).json(body);
          fireNextCallsIfAny(status, body);
          return;
        }
        const updated = current.slice();
        updated.splice(idx, 1);
        await col.updateOne({ _id: docId }, { $set: { data_current: updated } }, { upsert: false });

        const status = 200;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          { params: { id: idFromUrl } },
          {
            fallback: { message: "{Path} with id {{params.id}} deleted successfully." },
            requireParamId: true,
            paramsIdOccurrences: 1,
            logicalPath,
          }
        );
        const body = {
          code: status,
          message: rendered?.message ?? "Deleted successfully.",
          data: null,
          success: true,
        };
        await logWithStatefulResponse(req, {
          projectId,
          originId,
          statefulId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          started,
          payload: req.body,
          statefulResponseId: responseId,
        });
        res.status(status).json(body);
        fireNextCallsIfAny(status, body);
        return;
      }

      // Xoá toàn bộ data của user hiện tại
      const uid = pickUserIdFromRequest(req);
      const keep = current.filter((x) => Number(x?.user_id) !== Number(uid));
      await col.updateOne({ _id: docId }, { $set: { data_current: keep } }, { upsert: false });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponseAdv(
        responsesBucket,
        status,
        {},
        {
          fallback: { message: "Delete all data with {Path} successfully." },
          requireParamId: false,
          paramsIdOccurrences: 0,
          logicalPath,
        }
      );
      const body = {
        code: status,
        message: rendered?.message ?? "Delete all data successfully.",
        data: null,
        success: true,
      };
      await logWithStatefulResponse(req, {
        projectId,
        originId,
        statefulId,
        method,
        path: rawPath,
        status,
        responseBody: body,
        started,
        payload: req.body,
        statefulResponseId: responseId,
      });
      res.status(status).json(body);
      fireNextCallsIfAny(status, body);
      return;
    }

    /* ===== Others ===== */
    {
      const status = 405;
      const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "Method Not Allowed" }, logicalPath });
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
      res.status(status).json(rendered);
      fireNextCallsIfAny(status, rendered);
      return;
    }
  } catch (err) {
    console.error("[statefulHandler] error:", err);
    const status = 500;
    const rendered = { message: "Internal Server Error", error: err.message };
    await logWithStatefulResponse(req, { projectId: null, originId: null, statefulId: null, method, path: rawPath, status, responseBody: rendered, started, payload: req.body });
    res.status(status).json(rendered);
    fireNextCallsIfAny(status, rendered);
    return;
  }
}

module.exports = statefulHandler;
