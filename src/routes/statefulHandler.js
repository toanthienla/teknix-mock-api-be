// Lấy giá trị theo path "a.b.c" trong object ctx
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
  if (value && typeof value === "object") {
    const out = Array.isArray(value) ? [] : {};
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

module.exports = async function statefulHandler(req, res, next) {
  try {
    const method = (req.method || "GET").toUpperCase();
    const basePath = req.universal?.basePath || req.endpoint?.path || req.path;
    const idFromUrl = Number(
      (req.params && req.params.id) ?? (req.universal && req.universal.idInUrl)
    );

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

    const dataQ = await req.db.stateful.query(
      `SELECT schema, data_current
         FROM endpoint_data_ful
        WHERE path = $1
        LIMIT 1`,
      [basePath]
    );
    if (!dataQ.rows[0]) {
      // chưa provision đúng
      return res
        .status(500)
        .json({
          message: "endpoint_data_ful not provisioned for path",
          path: basePath,
        });
    }
    const schema = normalizeJsonb(dataQ.rows[0].schema) || {};
    const current = normalizeJsonb(dataQ.rows[0].data_current) || [];

    const responsesMap = await loadResponsesMap(req.db.stateful, endpointId);

    // 2) Router theo method → chỉ trả {status, ctx, maybe newData}
    const payload = req.body || {};

    if (method === "GET") {
      if (Number.isFinite(idFromUrl)) {
        const item = current.find((x) => Number(x?.id) === idFromUrl);
        if (!item) {
          return sendResponse(
            res,
            404,
            responsesMap,
            { params: { id: idFromUrl } },
            { message: "Not found." }
          );
        }
        return res.status(200).json(item); // by-id trả trực tiếp item
      }
      return res.status(200).json(current); // get-all
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
      await req.db.stateful.query(
        `UPDATE endpoint_data_ful SET data_current = $2 WHERE path = $1`,
        [basePath, JSON.stringify(updated)]
      );
      return sendResponse(
        res,
        201,
        responsesMap,
        { params: { id: newId } },
        { message: "Created." }
      );
    }

    if (method === "PUT") {
      if (!Number.isFinite(idFromUrl)) {
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

      await req.db.stateful.query(
        `UPDATE endpoint_data_ful SET data_current = $2 WHERE path = $1`,
        [basePath, JSON.stringify(updated)]
      );
      return sendResponse(
        res,
        200,
        responsesMap,
        { params: { id: idFromUrl } },
        { message: "Updated." }
      );
    }

    if (method === "DELETE") {
      if (Number.isFinite(idFromUrl)) {
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
        await req.db.stateful.query(
          `UPDATE endpoint_data_ful SET data_current = $2 WHERE path = $1`,
          [basePath, JSON.stringify(updated)]
        );
        return sendResponse(
          res,
          200,
          responsesMap,
          { params: { id: idFromUrl } },
          { message: "Deleted." }
        );
      }
      // delete all
      await req.db.stateful.query(
        `UPDATE endpoint_data_ful SET data_current = '[]'::jsonb WHERE path = $1`,
        [basePath]
      );
      return sendResponse(
        res,
        200,
        responsesMap,
        {},
        { message: "Deleted all." }
      );
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
