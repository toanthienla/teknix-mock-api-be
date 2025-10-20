// src/routes/statefulHandler.js
const { getCollection } = require("../config/db");
const logSvc = require("../services/project_request_log.service");

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
    rendered = JSON.parse(expandStaticPlaceholders(JSON.stringify(tmp), logicalPath));
  }
  return { rendered, responseId: entry?.id ?? null };
}

/* ========== Auth/Schema ========== */
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
    const finalResponseId = await resolveStatefulResponseId(req.db.stateful, statefulId, statefulResponseId);
    await logSvc.insertLog(req.db.stateless, {
      project_id: projectId ?? null,
      endpoint_id: originId ?? null, // stateless endpoints.id
      endpoint_response_id: null, // NULL trong flow stateful
      stateful_endpoint_id: statefulId ?? null, // endpoints_ful.id (no FK)
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

/* ========== MAIN ========== */
module.exports = async function statefulHandler(req, res, next) {
  const started = Date.now();

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

  if (!workspaceName || !projectName || !basePath) {
    const status = 400;
    const body = { message: "Full route required: /{workspaceName}/{projectName}/{path}", detail: { method, path: rawPath } };
    await logWithStatefulResponse(req, { projectId: null, originId: null, statefulId: null, method, path: rawPath, status, responseBody: body, started, payload: req.body, statefulResponseId: null });
    return res.status(status).json(body);
  }

  const statefulId = meta.statefulId || null; // endpoints_ful.id
  let originId = meta.statelessId || null; // endpoints.id (stateless)
  let folderId = null;
  let projectId = null;
  let isPublic = false;

  try {
    if (!statefulId) {
      const status = 404;
      const body = { message: "Endpoint not found", detail: { method, path: rawPath } };
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body, statefulResponseId: null });
      return res.status(status).json(body);
    }

    /* 1) LẤY origin_id, folder_id Ở DB STATEFUL */
    {
      const ef = await req.db.stateful.query("SELECT origin_id, folder_id FROM endpoints_ful WHERE id = $1 LIMIT 1", [statefulId]);
      if (!ef.rows[0]) {
        const status = 404;
        const body = { message: "Stateful endpoint not found", detail: { statefulId } };
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
        return res.status(status).json(body);
      }
      originId = originId || ef.rows[0].origin_id || null;
      folderId = ef.rows[0].folder_id || null;
    }

    /* 2) TỪ folder_id → LẤY project_id, is_public Ở DB STATELESS */
    if (folderId != null) {
      const prj = await req.db.stateless.query("SELECT project_id, is_public FROM folders WHERE id = $1 LIMIT 1", [folderId]);
      projectId = prj.rows[0]?.project_id ?? null;
      isPublic = !!prj.rows[0]?.is_public;
    }

    /* 3) LOAD MONGO DOC */
    const collectionName = buildCollectionName(logicalPath, workspaceName, projectName);
    const col = getCollection(collectionName);
    const doc = await loadInitializedDoc(col);
    if (!doc) {
      const status = 404;
      const body = { message: `Collection ${collectionName} is not initialized (missing seeded document).` };
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
      return res.status(status).json(body);
    }
    const docId = doc._id;
    const current = Array.isArray(doc.data_current) ? doc.data_current : doc.data_current ? [doc.data_current] : [];

    /* 4) LOAD SCHEMA Ở DB STATEFUL */
    const { rows: schRows } = await req.db.stateful.query("SELECT schema FROM endpoints_ful WHERE id = $1 LIMIT 1", [statefulId]);
    const schema = normalizeJsonb(schRows?.[0]?.schema) || {};

    /* 5) BASE SCHEMA Ở DB STATELESS (Dùng folderId đã lấy) */
    let baseSchema = {};
    if (folderId != null) {
      const { rows: baseRows } = await req.db.stateless.query("SELECT base_schema FROM folders WHERE id = $1 LIMIT 1", [folderId]);
      baseSchema = normalizeJsonb(baseRows?.[0]?.base_schema) || {};
    }

    /* 6) LOAD RESPONSE BUCKET Ở DB STATEFUL */
    const responsesBucket = await loadResponsesBucket(req.db.stateful, statefulId);

    /* ===== GET ===== */
    if (method === "GET") {
      const userIdMaybe = pickUserIdFromRequest(req);

      const pickForGET = (obj) => {
        const fields = Array.isArray(schema?.fields) ? schema.fields : [];
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

      if (isPublic) {
        if (hasId) {
          const any = current.find((x) => Number(x?.id) === Number(idFromUrl));
          if (any) {
            const body = pickForGET(any);
            const status = 200;
            await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
            return res.status(status).json(body);
          }
          const status = 404;
          const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, { params: { id: idFromUrl } }, { fallback: { message: "{Path} with id {{params.id}} not found." }, requireParamId: true, paramsIdOccurrences: 1, logicalPath });
          await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
          return res.status(status).json(rendered);
        }
        const all = current.map(pickForGET);
        const status = 200;
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: all, started, payload: req.body });
        return res.status(status).json(all);
      }

      // PRIVATE
      if (hasId) {
        const uid = pickUserIdFromRequest(req);
        const rec = current.find((x) => Number(x?.id) === Number(idFromUrl));
        const allowed = rec && (rec.user_id == null || (uid != null && Number(rec.user_id) === Number(uid)));
        if (allowed) {
          const body = pickForGET(rec);
          const status = 200;
          await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
          return res.status(status).json(body);
        }
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, { params: { id: idFromUrl } }, { fallback: { message: "{Path} with id {{params.id}} not found." }, requireParamId: true, paramsIdOccurrences: 1, logicalPath });
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
        return res.status(status).json(rendered);
      }

      const uid = pickUserIdFromRequest(req);
      const defaults = current.filter((x) => x.user_id == null || x.user_id === undefined).map(pickForGET);
      const mine = uid == null ? [] : current.filter((x) => Number(x?.user_id) === Number(uid)).map(pickForGET);
      const body = [...defaults, ...mine];
      const status = 200;
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
      return res.status(status).json(body);
    }

    /* ===== POST ===== */
    if (method === "POST") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      // doc đã seed
      const mongoDb = col.s.db;
      const exists = (await mongoDb.listCollections({ name: collectionName }).toArray()).some((c) => c.name === collectionName);
      if (!exists || !docId) {
        const status = 404;
        const body = { message: `Collection ${collectionName} is not initialized (missing seeded document).` };
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
        return res.status(status).json(body);
      }

      const payload = req.body || {};
      const endpointSchema = schema || {};

      // kiểm tra thứ tự fields
      const schemaKeys = Object.keys(endpointSchema);
      const payloadKeys = Object.keys(payload);
      const sameOrder = schemaKeys.length === payloadKeys.length && schemaKeys.every((k, i) => k === payloadKeys[i]);
      if (!sameOrder) {
        const status = 400;
        const body = { message: "Invalid data: field order does not match schema." };
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload });
        return res.status(status).json(body);
      }

      for (const [k, rule] of Object.entries(endpointSchema)) {
        const v = payload[k];
        if (v === undefined || v === null) continue;
        if (rule.type === "number" && typeof v !== "number") return res.status(400).json({ message: `Invalid type for ${k}: expected number.` });
        if (rule.type === "string" && typeof v !== "string") return res.status(400).json({ message: `Invalid type for ${k}: expected string.` });
        if (rule.type === "boolean" && typeof v !== "boolean") return res.status(400).json({ message: `Invalid type for ${k}: expected boolean.` });
      }

      const { ok } = validateAndSanitizePayload(endpointSchema, payload, { allowMissingRequired: false, rejectUnknown: true });
      if (!ok) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "Invalid data: request does not match {path} object schema." }, logicalPath });
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload, statefulResponseId: responseId });
        return res.status(status).json(rendered);
      }

      const baseKeys = Object.keys(baseSchema || {});
      const schemaKeysForInsert = Object.keys(endpointSchema);
      const unionKeys = Array.from(new Set([...baseKeys, ...schemaKeysForInsert])).filter((k) => k !== "user_id");

      // id rule
      const idRule = endpointSchema?.id || {};
      let newId = payload.id;
      if (idRule?.required === true && (newId === undefined || newId === null)) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "Invalid data: request does not match {path} object schema." }, logicalPath });
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload, statefulResponseId: responseId });
        return res.status(status).json(rendered);
      }
      if (idRule?.required === false && (newId === undefined || newId === null)) {
        const maxId = current.reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0);
        newId = maxId + 1;
      }
      if (newId !== undefined && current.some((x) => Number(x?.id) === Number(newId))) {
        const status = 409;
        const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, { params: { id: newId } }, { fallback: { message: "{Path} {{params.id}} conflict: {{params.id}} already exists." }, requireParamId: true, paramsIdOccurrences: 1, logicalPath });
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload, statefulResponseId: responseId });
        return res.status(status).json(rendered);
      }

      const extraKeys = unionKeys.filter((k) => !schemaKeysForInsert.includes(k) && k !== "id");
      const insertOrder = [...schemaKeysForInsert, ...extraKeys];
      const newObj = {};
      for (const k of insertOrder) {
        if (k === "id") newObj.id = newId;
        else if (Object.prototype.hasOwnProperty.call(payload, k)) newObj[k] = payload[k];
        else newObj[k] = null;
      }
      newObj.user_id = Number(userId);

      const updated = [...current, newObj];
      await col.updateOne({ _id: docId }, { $set: { data_current: updated } }, { upsert: false });

      const status = 201;
      const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "New {path} item added successfully." }, logicalPath });
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
      return res.status(status).json(rendered);
    }

    /* ===== PUT ===== */
    if (method === "PUT") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      const mongoDb = col.s.db;
      const exists = (await mongoDb.listCollections({ name: collectionName }).toArray()).some((c) => c.name === collectionName);
      if (!exists || !docId) {
        const status = 404;
        const body = { message: `Collection ${collectionName} is not initialized (missing seeded document).` };
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
        return res.status(status).json(body);
      }

      if (!hasId) {
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "Not found." }, requireParamId: false, logicalPath });
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
        return res.status(status).json(rendered);
      }

      const idx = current.findIndex((x) => Number(x?.id) === Number(idFromUrl));
      if (idx === -1) {
        const status = 404;
        const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, { params: { id: idFromUrl } }, { fallback: { message: "{Path} with id {{params.id}} not found." }, requireParamId: true, paramsIdOccurrences: 1, logicalPath });
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
        return res.status(status).json(rendered);
      }

      const ownerId = Number(current[idx]?.user_id);
      if (ownerId !== Number(userId)) {
        const status = 403;
        const body = { error: "Forbidden" };
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
        return res.status(status).json(body);
      }

      const payload = req.body || {};
      if (Object.prototype.hasOwnProperty.call(payload, "user_id")) delete payload.user_id;

      const schemaKeys = Object.keys(schema || {});
      const payloadKeys = Object.keys(payload);
      const sameOrder = schemaKeys.length === payloadKeys.length && schemaKeys.every((k, i) => k === payloadKeys[i]);
      if (!sameOrder) {
        const status = 400;
        const body = { message: "Invalid data: field order does not match schema." };
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload });
        return res.status(status).json(body);
      }

      for (const [k, rule] of Object.entries(schema || {})) {
        const v = payload[k];
        if (v === undefined || v === null) continue;
        if (rule.type === "number" && typeof v !== "number") return res.status(400).json({ message: `Invalid type for ${k}: expected number.` });
        if (rule.type === "string" && typeof v !== "string") return res.status(400).json({ message: `Invalid type for ${k}: expected string.` });
        if (rule.type === "boolean" && typeof v !== "boolean") return res.status(400).json({ message: `Invalid type for ${k}: expected boolean.` });
      }

      const { ok } = validateAndSanitizePayload(schema, payload, { allowMissingRequired: false, rejectUnknown: true });
      if (!ok) {
        const status = 400;
        const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "Invalid data: request does not match {path} schema." }, logicalPath });
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
        return res.status(status).json(rendered);
      }

      const schemaKeysForUpdate = Object.keys(schema || {});
      const extraKeys = Object.keys(current[idx] || {}).filter((k) => !schemaKeysForUpdate.includes(k) && k !== "user_id");
      const updateOrder = [...schemaKeysForUpdate, ...extraKeys];

      const updatedItem = {};
      for (const k of updateOrder) {
        if (k === "id") updatedItem.id = idFromUrl;
        else if (Object.prototype.hasOwnProperty.call(payload, k)) updatedItem[k] = payload[k];
        else updatedItem[k] = current[idx]?.[k] ?? null;
      }
      updatedItem.user_id = ownerId;

      const updated = current.slice();
      updated[idx] = updatedItem;
      await col.updateOne({ _id: docId }, { $set: { data_current: updated } }, { upsert: false });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, { params: { id: idFromUrl } }, { fallback: { message: "{Path} with id {{params.id}} updated successfully." }, requireParamId: true, paramsIdOccurrences: 1, logicalPath });
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
      return res.status(status).json(rendered);
    }

    /* ===== DELETE ===== */
    if (method === "DELETE") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      const mongoDb = col.s.db;
      const exists = (await mongoDb.listCollections({ name: collectionName }).toArray()).some((c) => c.name === collectionName);
      if (!exists || !docId) {
        const status = 404;
        const body = { message: `Collection ${collectionName} is not initialized (missing seeded document).` };
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
        return res.status(status).json(body);
      }

      if (hasId) {
        const idx = current.findIndex((x) => Number(x?.id) === Number(idFromUrl));
        if (idx === -1) {
          const status = 404;
          const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, { params: { id: idFromUrl } }, { fallback: { message: "{Path} with id {{params.id}} to delete not found." }, requireParamId: true, paramsIdOccurrences: 1, logicalPath });
          await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
          return res.status(status).json(rendered);
        }

        const ownerId = Number(current[idx]?.user_id);
        if (ownerId !== Number(userId)) {
          const status = 403;
          const body = { error: "Forbidden" };
          await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: body, started, payload: req.body });
          return res.status(status).json(body);
        }

        const updated = current.slice();
        updated.splice(idx, 1);
        await col.updateOne({ _id: docId }, { $set: { data_current: updated } }, { upsert: false });

        const status = 200;
        const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, { params: { id: idFromUrl } }, { fallback: { message: "{Path} with id {{params.id}} deleted successfully." }, requireParamId: true, paramsIdOccurrences: 1, logicalPath });
        await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
        return res.status(status).json(rendered);
      }

      // Xoá toàn bộ data của user hiện tại
      const uid = pickUserIdFromRequest(req);
      const keep = current.filter((x) => Number(x?.user_id) !== Number(uid));
      await col.updateOne({ _id: docId }, { $set: { data_current: keep } }, { upsert: false });

      const status = 200;
      const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "Delete all data with {Path} successfully." }, requireParamId: false, paramsIdOccurrences: 0, logicalPath });
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
      return res.status(status).json(rendered);
    }

    /* ===== Others ===== */
    {
      const status = 405;
      const { rendered, responseId } = selectAndRenderResponseAdv(responsesBucket, status, {}, { fallback: { message: "Method Not Allowed" }, logicalPath });
      await logWithStatefulResponse(req, { projectId, originId, statefulId, method, path: rawPath, status, responseBody: rendered, started, payload: req.body, statefulResponseId: responseId });
      return res.status(status).json(rendered);
    }
  } catch (err) {
    console.error("[statefulHandler] error:", err);
    const status = 500;
    const rendered = { message: "Internal Server Error", error: err.message };
    await logWithStatefulResponse(req, { projectId: null, originId: null, statefulId: null, method, path: rawPath, status, responseBody: rendered, started, payload: req.body });
    return res.status(status).json(rendered);
  }
};
