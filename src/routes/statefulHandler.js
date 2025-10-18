// src/routes/statefulHandler.js
const { getCollection } = require("../config/db");
const logSvc = require("../services/project_request_log.service");

// ============ Generic helpers ============
function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.connection?.remoteAddress || req.ip || null;
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
    try {
      return JSON.parse(x);
    } catch {
      return x;
    }
  }
  return x;
}
// Title-case cho {Path} và lower cho {path}
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
  // Nếu có id_conflict → thay 2 lần {{params.id}}: lần 1 = id, lần 2 = id_conflict
  if (ctx?.params && ctx.params.id_conflict != null) {
    let count = 0;
    let out = tpl.replace(/\{\{\s*params\.id\s*\}\}/g, () => {
      count += 1;
      return String(count === 1 ? ctx.params.id : ctx.params.id_conflict);
    });
    // Render các token khác
    out = out.replace(/\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}/g, (_, path) => {
      if (path === "params.id") return ""; // nếu còn sót
      const v = getByPath(ctx, path);
      return v == null ? "" : String(v);
    });
    return out;
  }
  return renderTemplateDeep(tpl, ctx);
}
// 🔧 đệ quy theo thứ tự cho mọi string bên trong object/array
function renderTemplateDeepOrdered(value, ctx) {
  if (typeof value === "string") {
    return renderTemplateWithOrderedParamsId(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderTemplateDeepOrdered(v, ctx));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderTemplateDeepOrdered(v, ctx);
    }
    return out;
  }
  return value;
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
    candidates = candidates.filter((e) => countParamsIdOccurrences(e.body) >= 1);
  } else if (requireParamId === false) {
    candidates = candidates.filter((e) => countParamsIdOccurrences(e.body) === 0);
  }
  if (paramsIdOccurrences != null) {
    const exact = candidates.filter((e) => countParamsIdOccurrences(e.body) === paramsIdOccurrences);
    if (exact.length) candidates = exact;
  }
  return candidates[0] || arr[0];
}
function selectAndRenderResponseAdv(bucket, status, ctx, { fallback, requireParamId, paramsIdOccurrences, logicalPath } = {}) {
  const entry = pickResponseEntryAdv(bucket, status, {
    requireParamId,
    paramsIdOccurrences,
  });
  const raw = entry?.body ?? fallback ?? { message: `HTTP ${status}` };

  let rendered;
  if (typeof raw === "string") {
    rendered = renderTemplateWithOrderedParamsId(raw, ctx);
    rendered = expandStaticPlaceholders(rendered, logicalPath);
  } else {
    const tmp = renderTemplateDeepOrdered(normalizeJsonb(raw), ctx);
    rendered = JSON.parse(expandStaticPlaceholders(JSON.stringify(tmp), logicalPath));
  }
  return { rendered, responseId: entry?.id ?? null };
}

// ============ Auth & Schema ============
function pickUserIdFromRequest(req) {
  const localsUser = req.res?.locals?.user;
  const uid = req.user?.id ?? req.user?.user_id ?? localsUser?.id ?? localsUser?.user_id ?? (req.headers["x-mock-user-id"] != null ? Number(req.headers["x-mock-user-id"]) : null);
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
  // ⬇️ reject string rỗng / toàn space
  if (expected === "string") return typeof value === "string" && value.trim() !== "";
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  return true;
}
function validateAndSanitizePayload(schema, payload, { allowMissingRequired = false, rejectUnknown = true }) {
  const errors = [];
  const sanitized = {};
  const schemaFields = Object.keys(schema || {});

  if (rejectUnknown) {
    const unknownKeys = Object.keys(payload || {}).filter((k) => !schemaFields.includes(k) && k !== "user_id");
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
async function insertLogSafely(req, { projectId, originId, method, path, status, responseBody, endpointResponseId = null, started, payload }) {
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
  const basePath = meta.basePath || req.path; // "/orders" hoặc "/orders/:id"
  const rawPath = meta.rawPath || req.originalUrl || req.path; // "/orders/4" hoặc "/orders"
  const idInUrl = meta.idInUrl; // number | null
  const hasId = idInUrl != null;
  const idFromUrl = hasId ? Number(idInUrl) : undefined;

  // workspace/project từ baseUrl (giữ logic cũ)
  const baseSegs = (req.baseUrl || "").split("/").filter(Boolean);
  const workspaceName = baseSegs[0] || null;
  const projectName = baseSegs[1] || null;

  // logicalPath (bỏ "/:id" nếu có trong basePath)
  const logicalPath = String(basePath || "").replace(/\/:id$/, "");

  if (!workspaceName || !projectName || !basePath) {
    const body = {
      message: "Full route required: /{workspaceName}/{projectName}/{path}",
      detail: { method, path: rawPath },
    };
    return res.status(400).json(body);
  }

  const statefulId = meta.statefulId || null;
  let originId = meta.statelessId || null;
  let projectId = null;
  let isPublic = false;

  try {
    if (!statefulId) {
      const status = 404;
      const body = {
        message: "Endpoint not found",
        detail: { method, path: rawPath },
      };
      await insertLogSafely(req, {
        projectId,
        originId,
        method,
        path: rawPath,
        status,
        responseBody: body,
        started,
        payload: req.body,
      });
      return res.status(status).json(body);
    }

    // --- Fetch endpoints_ful info (origin_id, folder_id) ---
    let folderId = null;
    {
      const efRow = await req.db.stateful.query("SELECT origin_id, folder_id FROM endpoints_ful WHERE id = $1 LIMIT 1", [statefulId]);
      if (efRow.rows[0]) {
        originId = originId || efRow.rows[0].origin_id || null;
        folderId = efRow.rows[0].folder_id || null;
      }
      if (folderId) {
        const prj = await req.db.stateless.query("SELECT project_id, is_public FROM folders WHERE id = $1 LIMIT 1", [folderId]);
        projectId = prj.rows[0]?.project_id ?? null;
        isPublic = Boolean(prj.rows[0]?.is_public);
      }
    }

    // --- Collection & data ---
    const collectionName = (function () {
      const sanitize = (s) =>
        String(s ?? "")
          .replace(/\u0000/g, "")
          .replace(/^\.+|\.+$/g, "");
      const logicalRest = String(logicalPath || "").replace(/^\/+/, "");
      return `${sanitize(logicalRest)}.${sanitize(workspaceName)}.${sanitize(projectName)}`;
    })();
    const col = getCollection(collectionName);
    const doc = (await col.findOne({})) || {
      data_current: [],
      data_default: [],
    };
    const current = Array.isArray(doc.data_current) ? doc.data_current : doc.data_current ? [doc.data_current] : [];
    const defaults = Array.isArray(doc.data_default) ? doc.data_default : doc.data_default ? [doc.data_default] : [];

    // --- Endpoint schema ---
    const { rows: schRows } = await req.db.stateful.query("SELECT schema FROM endpoints_ful WHERE id = $1 LIMIT 1", [statefulId]);
    const schema = normalizeJsonb(schRows?.[0]?.schema) || {};

    // --- Folder base_schema ---
    let baseSchema = {};
    if (folderId) {
      const { rows: baseRows } = await req.db.stateless.query("SELECT base_schema FROM folders WHERE id = $1 LIMIT 1", [folderId]);
      baseSchema = normalizeJsonb(baseRows?.[0]?.base_schema) || {};
    }

    // --- Responses bucket ---
    const responsesBucket = await loadResponsesBucket(req.db.stateful, statefulId);

    // =================== GET ===================
    if (method === "GET") {
      const userIdMaybe = pickUserIdFromRequest(req);

      // 🔹 Lấy is_public từ bảng folders trong DB stateless
      let isPublic = false;
      try {
        const folderRow = await req.db.stateless.query(
          "SELECT is_public FROM folders WHERE id = $1 LIMIT 1",
          [folder_id]
        );
        isPublic = folderRow.rows[0]?.is_public ?? false;
      } catch (err) {
        console.error("Error fetching folder.is_public:", err);
      }

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

      // ==============================
      // CASE 1: folder PRIVATE
      // ==============================
      if (!isPublic) {
        // Trả toàn bộ data_current
        const all = current.map(pickForGET);
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status: 200,
          responseBody: all,
          endpointResponseId: null,
          started,
          payload: req.body,
        });
        return res.status(200).json(all);
      }

      // ==============================
      // CASE 2: folder PUBLIC
      // ==============================
      const defaultRecords = current.filter(x => x.user_id == null || x.user_id === undefined);
      const userRecords = userIdMaybe == null ? [] : current.filter(x => Number(x?.user_id) === Number(userIdMaybe));

      if (hasId) {
        const foundUser = userRecords.find(x => Number(x?.id) === idFromUrl);
        const foundDefault = defaultRecords.find(x => Number(x?.id) === idFromUrl);
        const foundOldDefault = defaults.find(x => Number(x?.id) === idFromUrl);

        const target = foundUser || foundDefault || foundOldDefault;
        if (target) {
          const body = pickForGET(target);
          await insertLogSafely(req, {
            projectId,
            originId,
            method,
            path: rawPath,
            status: 200,
            responseBody: body,
            endpointResponseId: null,
            started,
            payload: req.body,
          });
          return res.status(200).json(body);
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
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: rendered,
          endpointResponseId: responseId,
          started,
          payload: req.body,
        });
        return res.status(status).json(rendered);
      }

      // Không có id => public: trả default + user data
      const defaultsOut = defaultRecords.map(pickForGET);
      const userOut = userRecords.map(pickForGET);
      const combined = [...defaultsOut, ...userOut];

      await insertLogSafely(req, {
        projectId,
        originId,
        method,
        path: rawPath,
        status: 200,
        responseBody: combined,
        endpointResponseId: null,
        started,
        payload: req.body,
      });
      return res.status(200).json(combined);
    }


    // =================== POST ===================
    if (method === "POST") {
      const userId = requireAuth(req, res);
      if (userId == null) {
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status: 403,
          responseBody: { error: "Unauthorized: login required." },
          endpointResponseId: null,
          started,
          payload: req.body,
        });
        return;
      }

      // 🧩 Kiểm tra collection có tồn tại không (dùng col lấy db)
      const mongoDb = col.db;
      const existingCollections = await mongoDb.listCollections({ name: collectionName }).toArray();
      const exists = existingCollections.some((c) => c.name === collectionName);
      if (!exists) {
        const status = 404;
        const body = { message: `Collection ${collectionName} does not exist.` };
        await insertLogSafely(req, {
          projectId,
          originId,
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

      const payload = req.body || {};
      const endpointSchema = schema || {};

      // 🧩 Kiểm tra thứ tự field so với schema (schemaOrder được khai báo rõ ràng)
      const schemaKeys = Object.keys(endpointSchema); // order from schema
      const payloadOrder = Object.keys(payload);
      // If schema doesn't define all keys, still require payload follows schemaKeys order exactly and length equal:
      const sameOrder =
        schemaKeys.length === payloadOrder.length &&
        schemaKeys.every((k, i) => k === payloadOrder[i]);
      if (!sameOrder) {
        const status = 400;
        const body = { message: "Invalid data: field order does not match schema." };
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          endpointResponseId: null,
          started,
          payload,
        });
        return res.status(status).json(body);
      }

      // 🧩 Kiểm tra type chặt chẽ hơn
      for (const [key, rule] of Object.entries(endpointSchema)) {
        const val = payload[key];
        if (val === undefined || val === null) continue;

        if (rule.type === "number" && typeof val !== "number") {
          const status = 400;
          const body = { message: `Invalid type for ${key}: expected number.` };
          await insertLogSafely(req, {
            projectId,
            originId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            endpointResponseId: null,
            started,
            payload,
          });
          return res.status(status).json(body);
        }

        if (rule.type === "string" && typeof val !== "string") {
          const status = 400;
          const body = { message: `Invalid type for ${key}: expected string.` };
          await insertLogSafely(req, {
            projectId,
            originId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            endpointResponseId: null,
            started,
            payload,
          });
          return res.status(status).json(body);
        }

        if (rule.type === "boolean" && typeof val !== "boolean") {
          const status = 400;
          const body = { message: `Invalid type for ${key}: expected boolean.` };
          await insertLogSafely(req, {
            projectId,
            originId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            endpointResponseId: null,
            started,
            payload,
          });
          return res.status(status).json(body);
        }
      }

      // 🔁 Phần logic POST cũ giữ nguyên validate/sanitize
      const { ok } = validateAndSanitizePayload(endpointSchema, payload, {
        allowMissingRequired: false,
        rejectUnknown: true,
      });
      if (!ok) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          {},
          {
            fallback: {
              message: "Invalid data: request does not match {path} object schema.",
            },
            logicalPath,
          }
        );
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: rendered,
          endpointResponseId: responseId,
          started,
          payload,
        });
        return res.status(status).json(rendered);
      }

      const unionKeys = Array.from(new Set([...Object.keys(baseSchema || {}), ...Object.keys(endpointSchema || {})])).filter((k) => k !== "user_id");

      const idRule = endpointSchema?.id || {};
      let newId = payload.id;
      if (idRule?.required === true && (newId === undefined || newId === null)) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          {},
          {
            fallback: {
              message: "Invalid data: request does not match {path} object schema.",
            },
            logicalPath,
          }
        );
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: rendered,
          endpointResponseId: responseId,
          started,
          payload,
        });
        return res.status(status).json(rendered);
      }
      if (idRule?.required === false && (newId === undefined || newId === null)) {
        const maxId = current.reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0);
        newId = maxId + 1;
      }

      if (newId !== undefined && current.some((x) => Number(x?.id) === Number(newId))) {
        const status = 409;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          { params: { id: newId } },
          {
            fallback: {
              message: "{Path} {{params.id}} conflict: {{params.id}} already exists.",
            },
            requireParamId: true,
            paramsIdOccurrences: 1,
            logicalPath,
          }
        );
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: rendered,
          endpointResponseId: responseId,
          started,
          payload,
        });
        return res.status(status).json(rendered);
      }

      // --- Xây dựng newObj theo đúng thứ tự schema ---
      // schemaKeys đã lấy ở trên (Object.keys(endpointSchema))
      // Nếu có các trường trong unionKeys mà schema không khai báo, append vào cuối theo thứ tự unionKeys
      const schemaKeysForInsert = Object.keys(endpointSchema);
      const extraKeys = unionKeys.filter((k) => !schemaKeysForInsert.includes(k) && k !== "id");
      const schemaOrder = [...schemaKeysForInsert, ...extraKeys];

      const newObj = {};
      for (const key of schemaOrder) {
        if (key === "id") {
          newObj.id = newId;
        } else if (Object.prototype.hasOwnProperty.call(payload, key)) {
          newObj[key] = payload[key];
        } else {
          newObj[key] = null;
        }
      }
      // Cuối cùng thêm user_id
      newObj.user_id = Number(userId);

      const updated = [...current, newObj];
      await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

      const status = 201;
      const { rendered, responseId } = selectAndRenderResponseAdv(
        responsesBucket,
        status,
        {},
        {
          fallback: { message: "New {path} item added successfully." },
          logicalPath,
        }
      );
      await insertLogSafely(req, {
        projectId,
        originId,
        method,
        path: rawPath,
        status,
        responseBody: rendered,
        endpointResponseId: responseId,
        started,
        payload,
      });
      return res.status(status).json(rendered);
    }


    // =================== PUT ===================
    if (method === "PUT") {
      const userId = requireAuth(req, res);
      if (userId == null) {
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status: 403,
          responseBody: { error: "Unauthorized: login required." },
          endpointResponseId: null,
          started,
          payload: req.body,
        });
        return;
      }

      // 🧩 Kiểm tra collection tồn tại
      const mongoDb = col.db;
      const existingCollections = await mongoDb.listCollections({ name: collectionName }).toArray();
      const exists = existingCollections.some((c) => c.name === collectionName);
      if (!exists) {
        const status = 404;
        const body = { message: `Collection ${collectionName} does not exist.` };
        await insertLogSafely(req, {
          projectId,
          originId,
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
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: rendered,
          endpointResponseId: responseId,
          started,
          payload: req.body,
        });
        return res.status(status).json(rendered);
      }

      const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
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
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: rendered,
          endpointResponseId: responseId,
          started,
          payload: req.body,
        });
        return res.status(status).json(rendered);
      }

      const ownerId = Number(current[idx]?.user_id);
      if (ownerId !== Number(userId)) {
        const status = 403;
        const body = { error: "Forbidden" };
        await insertLogSafely(req, {
          projectId,
          originId,
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

      const payload = req.body || {};
      if (Object.prototype.hasOwnProperty.call(payload, "user_id")) delete payload.user_id;

      // 🧩 Kiểm tra thứ tự field (schemaKeys khai báo rõ ràng)
      const schemaKeys = Object.keys(schema || {});
      const payloadOrder = Object.keys(payload);
      const sameOrder =
        schemaKeys.length === payloadOrder.length &&
        schemaKeys.every((k, i) => k === payloadOrder[i]);
      if (!sameOrder) {
        const status = 400;
        const body = { message: "Invalid data: field order does not match schema." };
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: body,
          endpointResponseId: null,
          started,
          payload,
        });
        return res.status(status).json(body);
      }

      // 🧩 Kiểm tra type chặt chẽ
      for (const [key, rule] of Object.entries(schema || {})) {
        const val = payload[key];
        if (val === undefined || val === null) continue;

        if (rule.type === "number" && typeof val !== "number") {
          const status = 400;
          const body = { message: `Invalid type for ${key}: expected number.` };
          await insertLogSafely(req, {
            projectId,
            originId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            endpointResponseId: null,
            started,
            payload,
          });
          return res.status(status).json(body);
        }

        if (rule.type === "string" && typeof val !== "string") {
          const status = 400;
          const body = { message: `Invalid type for ${key}: expected string.` };
          await insertLogSafely(req, {
            projectId,
            originId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            endpointResponseId: null,
            started,
            payload,
          });
          return res.status(status).json(body);
        }

        if (rule.type === "boolean" && typeof val !== "boolean") {
          const status = 400;
          const body = { message: `Invalid type for ${key}: expected boolean.` };
          await insertLogSafely(req, {
            projectId,
            originId,
            method,
            path: rawPath,
            status,
            responseBody: body,
            endpointResponseId: null,
            started,
            payload,
          });
          return res.status(status).json(body);
        }
      }

      // 🔁 Giữ nguyên logic PUT cũ từ đây (nhưng xây dựng updatedItem theo thứ tự schema)
      const { ok } = validateAndSanitizePayload(schema, payload, {
        allowMissingRequired: false,
        rejectUnknown: true,
      });
      if (!ok) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          {},
          {
            fallback: {
              message: "Invalid data: request does not match {path} schema.",
            },
            logicalPath,
          }
        );
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: rendered,
          endpointResponseId: responseId,
          started,
          payload: req.body,
        });
        return res.status(status).json(rendered);
      }

      // Tạo updatedItem theo thứ tự schema (nếu schema không chứa một vài trường, append các trường cũ còn lại)
      const schemaKeysForUpdate = Object.keys(schema || {});
      const extraKeysForUpdate = Object.keys(current[idx] || {}).filter((k) => !schemaKeysForUpdate.includes(k) && k !== "user_id");
      const schemaOrderForUpdate = [...schemaKeysForUpdate, ...extraKeysForUpdate];

      const updatedItem = {};
      for (const key of schemaOrderForUpdate) {
        if (key === "id") {
          updatedItem.id = idFromUrl; // id từ URL
        } else if (Object.prototype.hasOwnProperty.call(payload, key)) {
          updatedItem[key] = payload[key];
        } else {
          // giữ nguyên giá trị cũ nếu có, ngược lại null
          updatedItem[key] = current[idx]?.[key] ?? null;
        }
      }
      // Cuối cùng thêm user_id
      updatedItem.user_id = ownerId;

      const updated = current.slice();
      updated[idx] = updatedItem;
      await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponseAdv(
        responsesBucket,
        status,
        { params: { id: idFromUrl } },
        {
          fallback: {
            message: "{Path} with id {{params.id}} updated successfully.",
          },
          requireParamId: true,
          paramsIdOccurrences: 1,
          logicalPath,
        }
      );
      await insertLogSafely(req, {
        projectId,
        originId,
        method,
        path: rawPath,
        status,
        responseBody: rendered,
        endpointResponseId: responseId,
        started,
        payload: req.body,
      });
      return res.status(status).json(rendered);
    }

    // =================== DELETE ===================
    if (method === "DELETE") {
      const userId = requireAuth(req, res);
      if (userId == null) {
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status: 403,
          responseBody: { error: "Unauthorized: login required." },
          endpointResponseId: null,
          started,
          payload: req.body,
        });
        return;
      }

      // 🧩 Kiểm tra collection có tồn tại không
      const mongoDb = col.db; // vì getCollection(collectionName) đã trả về collection hợp lệ
      const existingCollections = await mongoDb.listCollections({ name: collectionName }).toArray();
      const exists = existingCollections.some(c => c.name === collectionName);
      if (!exists) {
        const status = 404;
        const body = { message: `Collection ${collectionName} does not exist.` };
        await insertLogSafely(req, {
          projectId,
          originId,
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


      if (hasId) {
        const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
        if (idx === -1) {
          const status = 404;
          const { rendered, responseId } = selectAndRenderResponseAdv(
            responsesBucket,
            status,
            { params: { id: idFromUrl } },
            {
              fallback: {
                message: "{Path} with id {{params.id}} to delete not found.",
              },
              requireParamId: true,
              paramsIdOccurrences: 1,
              logicalPath,
            }
          );
          await insertLogSafely(req, {
            projectId,
            originId,
            method,
            path: rawPath,
            status,
            responseBody: rendered,
            endpointResponseId: responseId,
            started,
            payload: req.body,
          });
          return res.status(status).json(rendered);
        }

        const ownerId = Number(current[idx]?.user_id);
        if (ownerId !== Number(userId)) {
          const status = 403;
          const body = { error: "Forbidden" };
          await insertLogSafely(req, {
            projectId,
            originId,
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

        // Xóa phần tử theo id
        const updated = current.slice();
        updated.splice(idx, 1);
        await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

        const status = 200;
        const { rendered, responseId } = selectAndRenderResponseAdv(
          responsesBucket,
          status,
          { params: { id: idFromUrl } },
          {
            fallback: {
              message: "{Path} with id {{params.id}} deleted successfully.",
            },
            requireParamId: true,
            paramsIdOccurrences: 1,
            logicalPath,
          }
        );
        await insertLogSafely(req, {
          projectId,
          originId,
          method,
          path: rawPath,
          status,
          responseBody: rendered,
          endpointResponseId: responseId,
          started,
          payload: req.body,
        });
        return res.status(status).json(rendered);
      }

      // Xóa toàn bộ theo user_id
      const keep = current.filter((x) => Number(x?.user_id) !== Number(userId));
      await col.updateOne({}, { $set: { data_current: keep } }, { upsert: true });

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
      await insertLogSafely(req, {
        projectId,
        originId,
        method,
        path: rawPath,
        status,
        responseBody: rendered,
        endpointResponseId: responseId,
        started,
        payload: req.body,
      });
      return res.status(status).json(rendered);
    }

    // =================== Method khác ===================
    {
      const status = 405;
      const body = { message: "Method Not Allowed" };
      await insertLogSafely(req, {
        projectId,
        originId,
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
