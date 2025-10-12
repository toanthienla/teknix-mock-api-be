// statefulHandler.js
const { getCollection } = require("../config/db");

// ============ Generic helpers ============
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
    `SELECT status_code, response_body
       FROM endpoint_responses_ful
      WHERE endpoint_id = $1
      ORDER BY id ASC`,
    [endpointId]
  );
  const bucket = new Map(); // status_code -> Array<body>
  for (const r of rows) {
    const body = normalizeJsonb(r.response_body);
    const key = Number(r.status_code);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(body);
  }
  return bucket;
}
function pickResponseBody(bucket, status, { requireParamId = null } = {}) {
  const arr = bucket.get(status) || [];
  if (arr.length === 0) return undefined;
  if (requireParamId === null) return arr[0];

  const hasParamToken = (obj) => {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    return s.includes("{{params.id}}");
  };
  const withParam = arr.find(hasParamToken);
  const withoutParam = arr.find((x) => !hasParamToken(x));
  return requireParamId
    ? (withParam ?? withoutParam ?? arr[0])
    : (withoutParam ?? withParam ?? arr[0]);
}
function renderTemplate(value, ctx) {
  const v = normalizeJsonb(value ?? { message: `HTTP ${ctx?.status ?? ""}` });
  return renderTemplateDeep(v, ctx || {});
}
function sendResponse(res, status, bucket, ctx, { fallback, requireParamId } = {}) {
  const picked = pickResponseBody(bucket, status, { requireParamId });
  const body = picked ?? fallback ?? { message: `HTTP ${status}` };
  const rendered = renderTemplate(body, { ...(ctx || {}), status });
  return res.status(status).json(rendered);
}
function renderBody(status, bucket, ctx, { fallback, requireParamId } = {}) {
  const picked = pickResponseBody(bucket, status, { requireParamId });
  const body = picked ?? fallback ?? { message: `HTTP ${status}` };
  return renderTemplate(body, { ...(ctx || {}), status });
}

// ============ Auth & Schema ============
function requireAuth(req, res) {
  const uid = req.user?.id ?? req.user?.user_id;
  if (uid == null) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return Number(uid);
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

/**
 * Validate payload theo schema:
 * - Bắt buộc tất cả field có rule.required === true phải có trong payload (POST/PUT).
 * - Type phải khớp nếu có `type`.
 * - Không cho phép field lạ ngoài schema (rejectUnknown = true).
 * - Trả { ok, errors, sanitized } với sanitized chỉ gồm field thuộc schema (và id nếu có rule).
 */
function validateAndSanitizePayload(schema, payload, {
  allowMissingRequired = false,
  rejectUnknown = true,
}) {
  const errors = [];
  const sanitized = {};
  const schemaFields = Object.keys(schema || {});

  // Unknown fields?
  if (rejectUnknown) {
    const unknownKeys = Object.keys(payload || {}).filter(
      (k) => !schemaFields.includes(k) && k !== "user_id" // user_id không được phép trong payload
    );
    if (unknownKeys.length) {
      errors.push(`Unknown fields: ${unknownKeys.join(", ")}`);
    }
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

  // Nếu schema có id, giữ lại id từ payload khi có
  if (schemaFields.includes("id") && payload.id !== undefined) {
    sanitized.id = payload.id;
  }

  return { ok: errors.length === 0, errors, sanitized };
}

// ============ Handler ============
module.exports = async function statefulHandler(req, res, next) {
  try {
    const method = (req.method || "GET").toUpperCase();
    const basePath = req.universal?.basePath || req.endpoint?.path || req.path;

    const rawId =
      (req.params && req.params.id) ?? (req.universal && req.universal.idInUrl);
    const hasId =
      rawId !== undefined &&
      rawId !== null &&
      String(rawId) !== "" &&
      /^\d+$/.test(String(rawId));
    const idFromUrl = hasId ? Number(rawId) : undefined;

    // Endpoint theo (method, path)
    const endpointId =
      req.endpoint_stateful?.id ||
      (await (async () => {
        const q = await req.db.stateful.query(
          `SELECT id FROM endpoints_ful WHERE UPPER(method) = $1 AND path = $2 LIMIT 1`,
          [method, basePath]
        );
        return q.rows[0]?.id;
      })());
    if (!endpointId) {
      return res.status(500).json({ message: "Stateful endpoint missing." });
    }

    // Folder & is_public
    let folderId = null, isPublic = false;
    {
      const efRow = await req.db.stateful.query(
        "SELECT folder_id FROM endpoints_ful WHERE id = $1 LIMIT 1",
        [endpointId]
      );
      if (efRow.rows[0]) folderId = efRow.rows[0].folder_id || null;
      if (folderId) {
        const prj = await req.db.stateless.query(
          "SELECT is_public FROM folders WHERE id = $1 LIMIT 1",
          [folderId]
        );
        isPublic = Boolean(prj.rows[0]?.is_public);
      }
    }

    // Mongo: data_current
    const col = getCollection(basePath.replace(/^\//, ""));
    const doc = (await col.findOne({})) || { data_current: [] };
    const current = Array.isArray(doc.data_current)
      ? doc.data_current
      : doc.data_current ? [doc.data_current] : [];

    // Schema theo endpointId
    const { rows: schRows } = await req.db.stateful.query(
      "SELECT schema FROM endpoints_ful WHERE id = $1 LIMIT 1",
      [endpointId]
    );
    const schema = normalizeJsonb(schRows?.[0]?.schema) || {};

    // Response templates
    const responsesBucket = await loadResponsesBucket(req.db.stateful, endpointId);

    // =================== GET ===================
    if (method === "GET") {
      // Chỉ trả các field thuộc keys của schema, ẩn user_id; không xét required.
      const pickForGET = (obj) => {
        const keys = Object.keys(schema || {});
        if (keys.length === 0) {
          const { user_id, ...rest } = obj; // không có schema → trả mọi thứ trừ user_id
          return rest;
        }
        const set = new Set(keys);
        const out = {};
        for (const k of set) {
          if (k === "user_id") continue;
          if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
        }
        // nếu object có id nhưng schema không khai báo id, vẫn giữ lại id
        if (!set.has("user_id") && Object.prototype.hasOwnProperty.call(obj, "id")) {
          out.id = obj.id;
        }
        return out;
      };

      const userIdMaybe = req.user?.id ?? req.user?.user_id;
      if (!isPublic && userIdMaybe == null) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const visible = isPublic
        ? current
        : current.filter((x) => Number(x?.user_id) === Number(userIdMaybe));

      if (hasId) {
        const item = (isPublic ? current : visible).find((x) => Number(x?.id) === idFromUrl);
        if (!item) {
          const rendered = renderBody(
            404, responsesBucket, { params: { id: idFromUrl } },
            { fallback: { message: "Not found." } }
          );
          return res.status(404).json(rendered);
        }
        return res.status(200).json(pickForGET(item));
      }

      return res.status(200).json(visible.map(pickForGET));
    }

    // =================== POST ===================
    if (method === "POST") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      const payload = req.body || {};
      const idRule = schema?.id || {};

      // id.required === true → bắt buộc gửi id
      if (idRule?.required === true && (payload.id === undefined || payload.id === null)) {
        return sendResponse(res, 403, responsesBucket, {}, {
          fallback: { message: "Invalid schema." },
        });
      }

      // Validate nghiêm ngặt: required + type + không field lạ
      const { ok, errors, sanitized } = validateAndSanitizePayload(schema, payload, {
        allowMissingRequired: false,
        rejectUnknown: true,
      });
      if (!ok) {
        return sendResponse(res, 403, responsesBucket, {}, {
          fallback: { message: "Invalid data: request does not match object schema." },
        });
      }

      // Auto-increment id nếu optional & không gửi
      let newId = sanitized.id;
      if (idRule?.required === false && (newId === undefined || newId === null)) {
        const maxId = current.reduce((m, x) => Math.max(m, Number(x?.id) || 0), 0);
        newId = maxId + 1;
      }

      // Conflict id
      if (newId !== undefined && current.some((x) => Number(x?.id) === Number(newId))) {
        return sendResponse(res, 409, responsesBucket, { params: { id: newId } }, {
          fallback: { message: "Conflict." },
        });
      }

      // Lưu: chỉ field theo schema + id + user_id
      const newObj = { ...sanitized, id: newId, user_id: Number(userId) };
      const updated = [...current, newObj];
      await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

      return sendResponse(res, 201, responsesBucket, { params: { id: newId } }, {
        fallback: { message: "Created." },
      });
    }

    // =================== PUT ===================
    if (method === "PUT") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      if (!hasId) {
        return sendResponse(res, 404, responsesBucket, {}, { fallback: { message: "Not found." } });
      }

      const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
      if (idx === -1) {
        return sendResponse(res, 404, responsesBucket, { params: { id: idFromUrl } }, {
          fallback: { message: "Not found." },
        });
      }

      // Chỉ chủ sở hữu
      const ownerId = Number(current[idx]?.user_id);
      if (ownerId !== Number(userId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const payload = req.body || {};
      if (Object.prototype.hasOwnProperty.call(payload, "user_id")) delete payload.user_id;

      // Nếu đổi id → kiểm tra trùng
      const targetId = payload.id;
      if (targetId !== undefined && Number(targetId) !== idFromUrl) {
        const exists = current.some((x) => Number(x?.id) === Number(targetId));
        if (exists) {
          return sendResponse(
            res,
            409,
            responsesBucket,
            { params: { id: idFromUrl, id_conflict: Number(targetId) } },
            { fallback: { message: "Conflict." } }
          );
        }
      }

      // Validate nghiêm ngặt: required + type + không field lạ (PUT yêu cầu có đủ các field required)
      const { ok, errors, sanitized } = validateAndSanitizePayload(schema, payload, {
        allowMissingRequired: false,
        rejectUnknown: true,
      });
      if (!ok) {
        return sendResponse(
          res, 403, responsesBucket, {},
          { fallback: { message: "Invalid data: request does not match object schema." } }
        );
      }

      // Merge như "git": chỉ cập nhật các field hợp lệ từ payload, không đụng các field khác đang có.
      const updatedItem = { ...current[idx], ...sanitized, user_id: ownerId };

      const updated = current.slice();
      updated[idx] = updatedItem;
      await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

      return sendResponse(res, 200, responsesBucket, { params: { id: idFromUrl } }, {
        fallback: { message: "Updated." },
      });
    }

    // =================== DELETE ===================
    if (method === "DELETE") {
      const userId = requireAuth(req, res);
      if (userId == null) return;

      if (hasId) {
        const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
        if (idx === -1) {
          return sendResponse(res, 404, responsesBucket, { params: { id: idFromUrl } }, {
            fallback: { message: "Not found." },
          });
        }
        // Only owner
        const ownerId = Number(current[idx]?.user_id);
        if (ownerId !== Number(userId)) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const updated = current.slice();
        updated.splice(idx, 1);
        await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });

        return sendResponse(
          res, 200, responsesBucket, { params: { id: idFromUrl } },
          { fallback: { message: "Deleted." }, requireParamId: true }
        );
      }

      // Xoá all: chỉ xoá của user hiện tại
      const keep = current.filter((x) => Number(x?.user_id) !== Number(userId));
      await col.updateOne({}, { $set: { data_current: keep } }, { upsert: true });

      return sendResponse(
        res, 200, responsesBucket, {},
        { fallback: { message: "Deleted all." }, requireParamId: false }
      );
    }

    return res.status(405).json({ message: "Method Not Allowed" });
  } catch (err) {
    console.error("[statefulHandler] error:", err);
    return res.status(500).json({ message: "Internal Server Error", error: err.message });
  }
};
