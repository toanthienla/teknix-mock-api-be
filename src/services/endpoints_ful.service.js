// src/services/endpoints_ful.service.js
// Refactor: function-based exports + Mongo data store per-path
// - Data động (data_default, data_current) → Mongo (mỗi path = 1 collection)
// - Schema → cột JSONB 'schema' trong endpoints_ful (Postgres)
// - Giữ nguyên cơ chế generate default responses & rules chỉnh sửa response

const { statefulPool, statelessPool, getCollection } = require("../config/db");
const ResponseStatefulService = require("./endpoint_responses_ful.service");

// ------------------------
// Helpers
// ------------------------
function toCollectionName(path) {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("Invalid path");
  }
  return path.replace(/^\//, "").trim();
}

async function mongoFindOneByPath(path) {
  const col = getCollection(toCollectionName(path));
  return await col.findOne({});
}

async function mongoDeleteAllByPath(path) {
  const col = getCollection(toCollectionName(path));
  const r = await col.deleteMany({});
  return r.deletedCount > 0;
}

async function mongoUpsertEmptyIfMissing(path) {
  const col = getCollection(toCollectionName(path));
  await col.updateOne(
    {},
    { $setOnInsert: { data_default: [], data_current: [] } },
    { upsert: true }
  );
}

// ------------------------
// Core queries (Postgres)
// ------------------------
async function findById(id) {
  const { rows } = await statefulPool.query(
    "SELECT * FROM endpoints_ful WHERE id = $1",
    [id]
  );
  return rows[0] || null;
}

async function findByFolderId(folderId) {
  const { rows } = await statefulPool.query(
    "SELECT * FROM endpoints_ful WHERE folder_id = $1 ORDER BY created_at DESC",
    [folderId]
  );
  return rows;
}

async function getFullDetailById(id) {
  const [endpoint, responses] = await Promise.all([
    findById(id),
    ResponseStatefulService.findByEndpointId(id),
  ]);
  if (!endpoint) return null;
  return { ...endpoint, is_stateful: true, responses: responses || [] };
}

// Xoá endpoint stateful + responses (Postgres) và data (Mongo)
async function deleteById(id) {
  const client = await statefulPool.connect();
  try {
    await client.query("BEGIN");

    const { rows: epRows } = await client.query(
      "SELECT path FROM endpoints_ful WHERE id = $1",
      [id]
    );
    const ep = epRows[0];
    if (!ep) {
      await client.query("ROLLBACK");
      return { success: false, notFound: true };
    }

    await client.query("DELETE FROM endpoint_responses_ful WHERE endpoint_id = $1", [id]);
    await client.query("DELETE FROM endpoints_ful WHERE id = $1", [id]);

    await client.query("COMMIT");

    // Mongo delete (ngoài transaction)
    if (ep.path) await mongoDeleteAllByPath(ep.path);

    return { success: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function findByOriginId(originId) {
  const { rows } = await statefulPool.query(
    "SELECT id FROM endpoints_ful WHERE origin_id = $1 LIMIT 1",
    [originId]
  );
  const hit = rows[0];
  if (!hit) return null;
  return await getFullDetailById(hit.id);
}

// Convert: stateless → stateful (tạo endpoints_ful, responses; data → Mongo)
async function convertToStateful(endpointId) {
  const clientStateless = await statelessPool.connect();
  const clientStateful = await statefulPool.connect();

  try {
    await clientStateless.query("BEGIN");
    await clientStateful.query("BEGIN");

    // 1) lấy endpoint gốc
    const { rows: [endpoint] } = await clientStateless.query(
      "SELECT * FROM endpoints WHERE id = $1",
      [endpointId]
    );
    if (!endpoint) throw new Error("Stateless endpoint not found");

    // 2) đã có stateful trước đó chưa?
    const { rows: existing } = await clientStateful.query(
      "SELECT id, is_active, path, method FROM endpoints_ful WHERE origin_id = $1 LIMIT 1",
      [endpoint.id]
    );

    if (existing.length > 0) {
      const statefulId = existing[0].id;

      await clientStateful.query(
        "UPDATE endpoints_ful SET is_active = TRUE, updated_at = NOW() WHERE id = $1",
        [statefulId]
      );
      await clientStateless.query(
        "UPDATE endpoints SET is_stateful = TRUE, is_active = FALSE, updated_at = NOW() WHERE id = $1",
        [endpointId]
      );

      await clientStateful.query("COMMIT");
      await clientStateless.query("COMMIT");

      // Đảm bảo Mongo + default responses
      await ensureDefaultsForReactivate(
        statefulId,
        existing[0].path ?? endpoint.path,
        existing[0].method ?? endpoint.method
      );

      return { stateful_id: statefulId };
    }

    // 3) convert lần đầu
    await clientStateless.query(
      "UPDATE endpoints SET is_stateful = TRUE, is_active = FALSE, updated_at = NOW() WHERE id = $1",
      [endpointId]
    );

    const { rows: [statefulEndpoint] } = await clientStateful.query(
      `INSERT INTO endpoints_ful (folder_id, name, method, path, is_active, origin_id, schema)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6::jsonb)
       RETURNING *`,
      [
        endpoint.folder_id,
        endpoint.name,
        endpoint.method,
        endpoint.path,
        endpoint.id,
        JSON.stringify({
          id: { type: "number", required: false },
        }),
      ]
    );

    // 🔹 [NEW] Sau khi tạo endpoints_ful, đảm bảo folder có base_schema mặc định nếu đang null
    const { rows: [folder] } = await clientStateless.query(
      `SELECT f.id, f.base_schema
   FROM folders f
   INNER JOIN endpoints e ON e.folder_id = f.id
   WHERE e.id = $1
   LIMIT 1`,
      [endpointId]
    );

    if (folder && folder.base_schema === null) {
      await clientStateless.query(
        `UPDATE folders
     SET base_schema = $1
     WHERE id = $2`,
        [
          JSON.stringify({
            id: { type: "number", required: false },
          }),
          folder.id,
        ]
      );
    }


    await clientStateful.query("COMMIT");
    await clientStateless.query("COMMIT");

    // Tạo default responses + khởi tạo collection Mongo trống
    const responsesResult = await generateDefaultResponses(statefulEndpoint);
    await mongoUpsertEmptyIfMissing(statefulEndpoint.path);

    return { stateless: endpoint, stateful: statefulEndpoint, responses: responsesResult };
  } catch (e) {
    try { await clientStateless.query("ROLLBACK"); } catch { }
    try { await clientStateful.query("ROLLBACK"); } catch { }
    throw e;
  } finally {
    clientStateless.release();
    clientStateful.release();
  }
}


async function revertToStateless(endpointId) {
  const clientStateless = await statelessPool.connect();
  const clientStateful = await statefulPool.connect();
  try {
    await clientStateless.query("BEGIN");
    await clientStateful.query("BEGIN");

    const { rows: existing } = await clientStateful.query(
      "SELECT id FROM endpoints_ful WHERE origin_id = $1 LIMIT 1",
      [endpointId]
    );
    if (existing.length > 0) {
      await clientStateful.query(
        "UPDATE endpoints_ful SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
        [existing[0].id]
      );
    }

    await clientStateless.query(
      "UPDATE endpoints SET is_stateful = FALSE, is_active = TRUE, updated_at = NOW() WHERE id = $1",
      [endpointId]
    );

    await clientStateless.query("COMMIT");
    await clientStateful.query("COMMIT");

    return {
      statefulExists: existing.length > 0,
      statefulActive: false,
      statelessIsStateful: false,
      statelessActive: true,
    };
  } catch (e) {
    await clientStateless.query("ROLLBACK");
    await clientStateful.query("ROLLBACK");
    throw e;
  } finally {
    clientStateless.release();
    clientStateful.release();
  }
}

// Đảm bảo có dữ liệu Mongo (trống nếu thiếu) + default responses
async function ensureDefaultsForReactivate(statefulId, path, method) {
  await mongoUpsertEmptyIfMissing(path);

  const { rows: respRows } = await statefulPool.query(
    "SELECT 1 FROM endpoint_responses_ful WHERE endpoint_id = $1 LIMIT 1",
    [statefulId]
  );
  if (respRows.length === 0) {
    await generateDefaultResponses({ id: statefulId, method, path });
  }
}

// ------------------------
// Default responses
// ------------------------
async function insertResponses(endpointId, responses) {
  const client = await statefulPool.connect();
  try {
    for (const res of responses) {
      await client.query(
        `INSERT INTO endpoint_responses_ful (endpoint_id, name, status_code, response_body, delay_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          endpointId,
          res.name,
          res.status_code,
          JSON.stringify(res.response_body ?? {}),
          res.delay_ms || 0,
        ]
      );
    }
    return { message: "Responses inserted", count: responses.length };
  } finally {
    client.release();
  }
}

function capitalizeFromPath(endpointPath) {
  const seg = (endpointPath || "").split("/").filter(Boolean).pop() || "Resource";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

async function ResponsesForGET(endpointId, endpointPath) {
  const R = capitalizeFromPath(endpointPath);
  const responses = [
    { name: "Get All Success", status_code: 200, response_body: [{}] },
    { name: "Get Detail Success", status_code: 200, response_body: {} },
    { name: "Get Detail Not Found", status_code: 404, response_body: { message: `${R} with id {{params.id}} not found.` } },
  ];
  return insertResponses(endpointId, responses);
}

async function ResponsesForPOST(endpointId, endpointPath) {
  const R = capitalizeFromPath(endpointPath);
  const responses = [
    { name: "Create Success", status_code: 201, response_body: { message: `New ${R} item added successfully.` } },
    { name: "Schema Invalid", status_code: 403, response_body: { message: `Invalid data: request does not match ${R} object schema.` } },
    { name: "ID Conflict", status_code: 409, response_body: { message: `${R} {{params.id}} conflict: {{params.id}} already exists.` } },
  ];
  return insertResponses(endpointId, responses);
}

async function ResponsesForPUT(endpointId, endpointPath) {
  const R = capitalizeFromPath(endpointPath);
  const responses = [
    { name: "Update Success", status_code: 200, response_body: { message: `${R} with id {{params.id}} updated successfully.` } },
    { name: "Schema Invalid", status_code: 403, response_body: { message: `Invalid data: request does not match ${R} schema.` } },
    { name: "ID Conflict", status_code: 409, response_body: { message: `Update id {{params.id}} conflict: ${R} id {{params.id}} in request body already exists.` } },
    { name: "Not Found", status_code: 404, response_body: { message: `${R} with id {{params.id}} not found.` } },
  ];
  return insertResponses(endpointId, responses);
}

async function ResponsesForDELETE(endpointId, endpointPath) {
  const R = capitalizeFromPath(endpointPath);
  const responses = [
    { name: "Delete All Success", status_code: 200, response_body: { message: `Delete all data with ${R} successfully.` } },
    { name: "Delete Success", status_code: 200, response_body: { message: `${R} with id {{params.id}} deleted successfully.` } },
    { name: "Not Found", status_code: 404, response_body: { message: `${R} with id {{params.id}} to delete not found.` } },
  ];
  return insertResponses(endpointId, responses);
}

async function generateDefaultResponses(endpoint) {
  const { id: endpointId, method, path } = endpoint;
  const map = {
    GET: ResponsesForGET,
    POST: ResponsesForPOST,
    PUT: ResponsesForPUT,
    DELETE: ResponsesForDELETE,
  };
  const fn = map[String(method).toUpperCase()];
  if (!fn) return { message: `No default responses for method: ${method}` };
  return fn(endpointId, path);
}

// ------------------------
// Response editing rule (unchanged)
// ------------------------
async function updateEndpointResponse(responseId, { response_body, delay }) {
  const client = await statefulPool.connect();
  try {
    const { rows: [response] } = await client.query(
      "SELECT * FROM endpoint_responses_ful WHERE id = $1",
      [responseId]
    );
    if (!response) throw new Error("Response not found");
    if (
      response.status_code === 200 &&
      (response.name === "Get All Success" || response.name === "Get Detail Success")
    ) {
      throw new Error("This response is not editable.");
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (response_body !== undefined) {
      updates.push(`response_body = $${idx++}`);
      values.push(JSON.stringify(response_body));
    }
    if (delay !== undefined) {
      updates.push(`delay_ms = $${idx++}`);
      values.push(delay);
    }

    if (updates.length === 0) return response;

    values.push(responseId);
    const { rows: [updated] } = await client.query(
      `UPDATE endpoint_responses_ful SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${idx} RETURNING *`,
      values
    );
    return updated;
  } finally {
    client.release();
  }
}

// ------------------------
// Update endpoint data (Schema in PG, data in Mongo)
// ------------------------
async function updateEndpointData(path, body) {
  if (!body) throw new Error("Body không hợp lệ hoặc thiếu");
  const { schema, data_default } = body;

  // Lấy row endpoints_ful theo path
  const { rows } = await statefulPool.query(
    "SELECT id, schema FROM endpoints_ful WHERE path = $1 LIMIT 1",
    [path]
  );
  if (rows.length === 0) throw new Error("Không tìm thấy endpoints_ful với path: " + path);

  const currentSchema = rows[0].schema || null;

  // Helpers validate (giữ tinh gọn)
  const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  const orderedSchemaKeys = (sch) => Object.keys(sch || {});
  const hasSameKeyOrderAsSchema = (obj, sch) => {
    const sKeys = orderedSchemaKeys(sch);
    const dKeys = Object.keys(obj || {});
    if (sKeys.length !== dKeys.length) return false;
    for (let i = 0; i < sKeys.length; i++) if (sKeys[i] !== dKeys[i]) return false;
    return true;
  };
  const validateObjectWithSchema = (obj, sch) => {
    const sKeys = orderedSchemaKeys(sch);
    if (!hasSameKeyOrderAsSchema(obj, sch)) {
      return { ok: false, reason: `Thứ tự/trường không khớp schema. Schema: [${sKeys.join(", ")}], Data: [${Object.keys(obj).join(", ")}]` };
    }
    for (const key of sKeys) {
      const rule = sch[key];
      const value = obj[key];
      const isMissing = value === undefined;
      if (rule.required && isMissing) return { ok: false, reason: `Thiếu trường bắt buộc: "${key}"` };
      if (!isMissing) {
        const jsType = typeOf(value);
        const ok =
          (rule.type === "number" && jsType === "number") ||
          (rule.type === "string" && jsType === "string") ||
          (rule.type === "boolean" && jsType === "boolean") ||
          (rule.type === "object" && jsType === "object") ||
          (rule.type === "array" && jsType === "array");
        if (!ok) return { ok: false, reason: `Sai kiểu "${key}". Mong đợi: ${rule.type}, thực tế: ${jsType}` };
      }
    }
    return { ok: true };
  };
  const autoAssignIdsIfAllowed = (dataArr, sch) => {
    if (!Array.isArray(dataArr)) throw new Error("data_default phải là một mảng object");
    const idOptional = !!(sch?.id && sch.id.type === "number" && sch.id.required === false);
    let nextId = 1;
    const seen = new Set();
    for (const o of dataArr) if (o && typeof o.id === "number") seen.add(o.id);
    if (seen.size > 0) nextId = Math.max(...seen) + 1;
    if (idOptional) {
      for (let i = 0; i < dataArr.length; i++) {
        if (dataArr[i].id === undefined) {
          dataArr[i].id = seen.size === 0 ? (i === 0 ? 1 : dataArr[i - 1].id + 1) : nextId++;
        }
      }
    }
    return dataArr;
  };
  const ensureUniqueIdsIfPresent = (dataArr) => {
    const set = new Set();
    for (const o of dataArr) {
      if (o.id !== undefined) {
        if (set.has(o.id)) return { ok: false, reason: `Trùng id trong data_default: ${o.id}` };
        set.add(o.id);
      }
    }
    return { ok: true };
  };
  const validateArrayWithSchema = (dataArr, sch) => {
    if (!Array.isArray(dataArr)) return { ok: false, reason: "data_default phải là mảng các object" };
    for (let i = 0; i < dataArr.length; i++) {
      const r = validateObjectWithSchema(dataArr[i], sch);
      if (!r.ok) return { ok: false, reason: `Phần tử thứ ${i} không hợp lệ: ${r.reason}` };
    }
    const u = ensureUniqueIdsIfPresent(dataArr);
    if (!u.ok) return u;
    return { ok: true };
  };

  // 1) Cả schema + data_default → cập nhật schema (PG) + validate + ghi Mongo
  if (schema && data_default) {
    if (typeof schema !== "object" || Array.isArray(schema))
      throw new Error("schema phải là object (map field -> rule)");
    if (!Array.isArray(data_default))
      throw new Error("data_default phải là mảng object");

    const cloned = JSON.parse(JSON.stringify(data_default));
    const withIds = autoAssignIdsIfAllowed(cloned, schema);
    const v = validateArrayWithSchema(withIds, schema);
    if (!v.ok) throw new Error(`Dữ liệu không khớp schema: ${v.reason}`);

    await statefulPool.query(
      "UPDATE endpoints_ful SET schema = $1, updated_at = NOW() WHERE path = $2",
      [JSON.stringify(schema), path]
    );

    const col = getCollection(toCollectionName(path));
    await col.updateOne(
      {},
      { $set: { data_default: withIds, data_current: withIds } },
      { upsert: true }
    );
    return await mongoFindOneByPath(path);
  }

  // 2) Chỉ schema → cập nhật PG; KHÔNG động vào Mongo
  if (schema && !data_default) {
    if (typeof schema !== "object" || Array.isArray(schema))
      throw new Error("schema phải là object (map field -> rule)");
    await statefulPool.query(
      "UPDATE endpoints_ful SET schema = $1, updated_at = NOW() WHERE path = $2",
      [JSON.stringify(schema), path]
    );
    return await findByPathPG(path);
  }

  // 3) Chỉ data_default → cần schema hiện tại
  if (!schema && data_default) {
    if (!currentSchema)
      throw new Error("Không thể cập nhật data_default khi chưa có schema hiện tại");
    if (!Array.isArray(data_default))
      throw new Error("data_default phải là mảng object");

    const cloned = JSON.parse(JSON.stringify(data_default));
    const withIds = autoAssignIdsIfAllowed(cloned, currentSchema);
    const v = validateArrayWithSchema(withIds, currentSchema);
    if (!v.ok) throw new Error(`data_default không khớp schema hiện tại: ${v.reason}`);

    const col = getCollection(toCollectionName(path));
    await col.updateOne(
      {},
      { $set: { data_default: withIds, data_current: withIds } },
      { upsert: true }
    );
    return await mongoFindOneByPath(path);
  }

  throw new Error("Payload phải có ít nhất một trong hai: schema hoặc data_default");
}

// tiện ích nhỏ để trả hàng PG theo path (khi chỉ sửa schema)
async function findByPathPG(path) {
  const { rows } = await statefulPool.query(
    "SELECT * FROM endpoints_ful WHERE path = $1 LIMIT 1",
    [path]
  );
  return rows[0] || null;
}

// Lấy schema của endpoint stateful thông qua origin_id (id bên stateless)
async function getEndpointSchema(statefulPool, originId) {
  try {
    // Truy vấn endpoint theo origin_id
    const { rows } = await statefulPool.query(
      `SELECT schema, method 
       FROM endpoints_ful 
       WHERE origin_id = $1 
       LIMIT 1`,
      [originId]
    );

    // Không tìm thấy endpoint
    if (rows.length === 0) {
      return { success: false, message: "Endpoint not found" };
    }

    const { schema, method } = rows[0];

    // Nếu là DELETE hoặc schema rỗng thì trả về object rỗng
    if (method === "DELETE" || !schema) {
      return { success: true, data: {} };
    }

    // Trả về schema (đảm bảo là object JSON)
    let parsedSchema;
    try {
      parsedSchema = typeof schema === "string" ? JSON.parse(schema) : schema;
    } catch {
      parsedSchema = schema; // fallback nếu schema đã là object
    }

    return { success: true, data: parsedSchema };
  } catch (error) {
    console.error("Error in getEndpointSchema:", error);
    return { success: false, message: error.message };
  }
}

// Lấy base_schema thông qua id của endpoint (stateless)
async function getBaseSchemaByEndpointId(statelessPool, endpointId) {
  // 1) Lấy folder_id từ bảng endpoints
  const { rows: endpointRows } = await statelessPool.query(
    `SELECT folder_id FROM endpoints WHERE id = $1 LIMIT 1`,
    [endpointId]
  );

  if (endpointRows.length === 0) {
    throw new Error("Endpoint not found");
  }

  const folderId = endpointRows[0].folder_id;

  // 2) Lấy base_schema từ bảng folders
  const { rows: folderRows } = await statelessPool.query(
    `SELECT base_schema FROM folders WHERE id = $1 LIMIT 1`,
    [folderId]
  );

  if (folderRows.length === 0) {
    throw new Error("Folder not found");
  }

  const baseSchema = folderRows[0].base_schema || null;

  if (!baseSchema) {
    return { fields: [] };
  }

  // ✅ Chuyển object -> array
  const fields = Object.entries(baseSchema).map(([key, value]) => ({
    name: key,
    type: value.type === "number" ? "integer" : value.type, // đổi "number" -> "integer" nếu cần
  }));

  return { fields };
}


// ------------------------
// Exports (function-based)
// ------------------------
module.exports = {
  findById,
  findByFolderId,
  getFullDetailById,
  deleteById,
  findByOriginId,
  convertToStateful,
  revertToStateless,
  ensureDefaultsForReactivate,
  generateDefaultResponses,
  insertResponses,
  ResponsesForGET,
  ResponsesForPOST,
  ResponsesForPUT,
  ResponsesForDELETE,
  updateEndpointResponse,
  updateEndpointData,
  getEndpointSchema,
  getBaseSchemaByEndpointId,
};
