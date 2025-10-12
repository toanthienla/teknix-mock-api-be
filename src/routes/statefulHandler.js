const { getCollection } = require("../config/db");
const logSvc = require("../services/project_request_log.service");
// Lấy giá trị theo path "a.b.c" trong object ctx

// Lấy IP đơn giản
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
  return path
    .split(".")
    .reduce(
      (acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined),
      obj
    );
}

// Render {{...}} đệ quy cho object/array/string
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
    for (const [k, v] of Object.entries(value))
      out[k] = renderTemplateDeep(v, ctx);
    return out;
  }
  return value;
}

// Chuẩn hoá jsonb trả từ pg (đôi khi là object, đôi khi là string)
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

// Tạo map {statusCode: response_body}
async function loadResponsesMap(db, endpointId) {
  const { rows } = await db.query(
    `SELECT status_code, response_body
       FROM endpoint_responses_ful
      WHERE endpoint_id = $1`,
    [endpointId]
  );
  const map = new Map();
  for (const r of rows)
    map.set(Number(r.status_code), normalizeJsonb(r.response_body));
  return map;
}

// Gửi response có render template
function sendResponse(res, status, responsesMap, ctx, fallback) {
  let body = responsesMap.get(status);
  body = normalizeJsonb(body ?? fallback ?? { message: `HTTP ${status}` });
  const rendered = renderTemplateDeep(body, ctx || {});
  return res.status(status).json(rendered);
}
// Render body để dùng ghi log rồi mới gửi
function renderBody(status, responsesMap, ctx, fallback) {
  let body = responsesMap.get(status);
  body = normalizeJsonb(body ?? fallback ?? { message: `HTTP ${status}` });
  return renderTemplateDeep(body, ctx || {});
}

module.exports = async function statefulHandler(req, res, next) {
  try {
    const started = Date.now();
    const method = (req.method || "GET").toUpperCase();
    const basePath = req.universal?.basePath || req.endpoint?.path || req.path;

    // --- FIX id=0 khi không có id ---
    const rawId =
      (req.params && req.params.id) ?? (req.universal && req.universal.idInUrl);
    const hasId =
      rawId !== undefined &&
      rawId !== null &&
      String(rawId) !== "" &&
      /^\d+$/.test(String(rawId));
    const idFromUrl = hasId ? Number(rawId) : undefined;
    // --------------------------------

    // 1) Resolve endpointId (stateful) & preload
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
    // Resolve stateless endpoint_id (origin) + project_id để ghi log
    let originId = null,
      projectId = null;
    const efRow = await req.db.stateful.query(
      "SELECT origin_id, folder_id FROM endpoints_ful WHERE id = $1 LIMIT 1",
      [endpointId]
    );
    if (efRow.rows[0]) {
      originId = efRow.rows[0].origin_id || null;
      const folderId = efRow.rows[0].folder_id || null;
      if (folderId) {
        const prj = await req.db.stateless.query(
          "SELECT project_id FROM folders WHERE id = $1 LIMIT 1",
          [folderId]
        );
        projectId = prj.rows[0]?.project_id ?? null;
      }
    }

    // Mongo: mỗi path là 1 collection
    const col = getCollection(basePath.replace(/^\//, ""));
    const doc = (await col.findOne({})) || { data_current: [] };
    const current = Array.isArray(doc.data_current)
      ? doc.data_current
      : doc.data_current
        ? [doc.data_current]
        : [];

    // Schema ở Postgres: endpoints_ful.schema
    const { rows: schRows } = await req.db.stateful.query(
      "SELECT schema FROM endpoints_ful WHERE path = $1 LIMIT 1",
      [basePath]
    );
    const schema = normalizeJsonb(schRows?.[0]?.schema) || {};

    const responsesMap = await loadResponsesMap(req.db.stateful, endpointId);

    // 2) Router theo method → chỉ trả {status, ctx, maybe newData}
    const payload = req.body || {};

    if (method === "GET") {
          // áp dụng filter theo schema.fields (id luôn được giữ)
   const applyGetFields = (obj) => {
      const list = Array.isArray(schema?.fields) ? schema.fields : null;
      if (!obj || typeof obj !== "object" || !list) return obj;
      const set = new Set(["id", ...list.filter((f) => f !== "id")]);
      const out = {};
      for (const k of set) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
      return out;
    };
      if (hasId) {
        const item = current.find((x) => Number(x?.id) === idFromUrl);
        if (!item) {
          const rendered = renderBody(
            404,
            responsesMap,
            { params: { id: idFromUrl } },
            { message: "Not found." }
          );
          // await logSvc.insertLog(req.db.stateless, {
          //   project_id: projectId,
          //   endpoint_id: originId,
          //   request_method: method,
          //   request_path: req.path,
          //   response_status_code: 404,
          //   response_body: rendered,
          //   ip_address: getClientIp(req),
          //   latency_ms: Date.now() - started,
          // });
          return res.status(404).json(rendered);
        }
        // await logSvc.insertLog(req.db.stateless, {
        //   project_id: projectId,
        //   endpoint_id: originId,
        //   request_method: method,
        //   request_path: req.path,
        //   response_status_code: 200,
        //   response_body: item,
        //   ip_address: getClientIp(req),
        //   latency_ms: Date.now() - started,
        // });
        return res.status(200).json(applyGetFields(item)); // filter fields
      }
      // await logSvc.insertLog(req.db.stateless, {
      //   project_id: projectId,
      //   endpoint_id: originId,
      //   request_method: method,
      //   request_path: req.path,
      //   response_status_code: 200,
      //   response_body: current,
      //   ip_address: getClientIp(req),
      //   latency_ms: Date.now() - started,
      // });
      return res.status(200).json(current.map(applyGetFields)); // filter fields
    }

    if (method === "POST") {
      // validate (đơn giản theo schema.id)
      if (
        schema?.id &&
        schema.id.required === true &&
        (payload.id === undefined || payload.id === null)
      ) {
        return sendResponse(
          res,
          403,
          responsesMap,
          {},
          { message: "Invalid schema." }
        );
      }
      // auto-increment id nếu optional và không gửi
      let newId = payload.id;
      if (
        schema?.id?.required === false &&
        (newId === undefined || newId === null)
      ) {
        const maxId = current.reduce(
          (m, x) => Math.max(m, Number(x?.id) || 0),
          0
        );
        newId = maxId + 1;
      }
      if (
        newId !== undefined &&
        current.some((x) => Number(x?.id) === Number(newId))
      ) {
        return sendResponse(
          res,
          409,
          responsesMap,
          { params: { id: newId } },
          { message: "Conflict." }
        );
      }
      const newObj = { ...payload, id: newId };
      const updated = [...current, newObj];
      await col.updateOne(
        {},
        { $set: { data_current: updated } },
        { upsert: true }
      );
      // Trả về 201 + body theo responsesMap
      const rendered = renderBody(
        201,
        responsesMap,
        { params: { id: newId } },
        { message: "Created." }
      );
      // await logSvc.insertLog(req.db.stateless, {
      //   project_id: projectId,
      //   endpoint_id: originId,
      //   request_method: method,
      //   request_path: req.path,
      //   request_headers: req.headers || {},
      //   request_body: payload || {},
      //   response_status_code: 201,
      //   response_body: rendered,
      //   ip_address: getClientIp(req),
      //   latency_ms: Date.now() - started,
      // });
      return res.status(201).json(rendered);
    }

    if (method === "PUT") {
      if (!hasId) {
        return sendResponse(
          res,
          404,
          responsesMap,
          {},
          { message: "Not found." }
        );
      }
      const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
      if (idx === -1) {
        return sendResponse(
          res,
          404,
          responsesMap,
          { params: { id: idFromUrl } },
          { message: "Not found." }
        );
      }

      // validate schema tối thiểu (tuỳ bạn siết thêm)
      // … (bạn có thể tái dùng hàm validatePayload(schema, payload))

      // xử lý đổi id (10 → 12)
      let targetId = payload.id;
      if (targetId !== undefined && Number(targetId) !== idFromUrl) {
        const exists = current.some((x) => Number(x?.id) === Number(targetId));
        if (exists) {
          return sendResponse(
            res,
            409,
            responsesMap,
            { params: { id: idFromUrl, id_old: idFromUrl, id_new: targetId } },
            { message: "Conflict." }
          );
        }
      }

      const updatedItem = { ...current[idx], ...payload };
      const updated = current.slice();
      updated[idx] = updatedItem;

      await col.updateOne(
        {},
        { $set: { data_current: updated } },
        { upsert: true }
      );
      const rendered = renderBody(
        200,
        responsesMap,
        { params: { id: idFromUrl } },
        { message: "Updated." }
      );
      // await logSvc.insertLog(req.db.stateless, {
      //   project_id: projectId,
      //   endpoint_id: originId,
      //   request_method: method,
      //   request_path: req.path,
      //   request_headers: req.headers || {},
      //   request_body: payload || {},
      //   response_status_code: 200,
      //   response_body: rendered,
      //   ip_address: getClientIp(req),
      //   latency_ms: Date.now() - started,
      // });
      return res.status(200).json(rendered);
    }

    if (method === "DELETE") {
      if (hasId) {
        const idx = current.findIndex((x) => Number(x?.id) === idFromUrl);
        if (idx === -1) {
          return sendResponse(
            res,
            404,
            responsesMap,
            { params: { id: idFromUrl } },
            { message: "Not found." }
          );
        }
        const updated = current.slice();
        updated.splice(idx, 1);
        await col.updateOne(
          {},
          { $set: { data_current: updated } },
          { upsert: true }
        );
        const rendered = renderBody(
          200,
          responsesMap,
          { params: { id: idFromUrl } },
          { message: "Deleted." }
        );
        // await logSvc.insertLog(req.db.stateless, {
        //   project_id: projectId,
        //   endpoint_id: originId,
        //   request_method: method,
        //   request_path: req.path,
        //   response_status_code: 200,
        //   response_body: rendered,
        //   ip_address: getClientIp(req),
        //   latency_ms: Date.now() - started,
        // });
        return res.status(200).json(rendered);
      }
      // delete all
      await col.updateOne({}, { $set: { data_current: [] } }, { upsert: true });
      const rendered = renderBody(
        200,
        responsesMap,
        {},
        { message: "Deleted all." }
      );
      // await logSvc.insertLog(req.db.stateless, {
      //   project_id: projectId,
      //   endpoint_id: originId,
      //   request_method: method,
      //   request_path: req.path,
      //   response_status_code: 200,
      //   response_body: rendered,
      //   ip_address: getClientIp(req),
      //   latency_ms: Date.now() - started,
      // });
      return res.status(200).json(rendered);
    }

    // Method khác
    return res.status(405).json({ message: "Method Not Allowed" });
  } catch (err) {
    console.error("[statefulHandler] error:", err);
    return res
      .status(500)
      .json({ message: "Internal Server Error", error: err.message });
  }
};
