// src/services/endpoints_ful.service.js
// Refactor: function-based exports + Mongo data store per-path
// - Data động (data_default, data_current) → Mongo (mỗi path = 1 collection)
// - Schema → cột JSONB 'schema' trong endpoints_ful (Postgres)
// - Giữ nguyên cơ chế generate default responses & rules chỉnh sửa response

const { statefulPool, statelessPool, getCollection } = require("../config/db");
const ResponseStatefulService = require("./endpoint_responses_ful.service");
const { dropCollectionByPath } = require("./endpoint_data_ful.service");

// ------------------------
// Helpers
// ------------------------
//  giữ nguyên dấu cách; chỉ bỏ NUL và dấu '.' ở đầu/cuối; bỏ leading '/'
function sanitizeName(s) {
  return String(s ?? "")
    .replace(/^\//, "")
    .replace(/\u0000/g, "") // Mongo cấm NUL
    .replace(/^\.+|\.+$/g, "") // tránh '.' ở đầu/cuối segment
    .trim();
}
function toCollectionName(path, workspaceName, projectName) {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("Invalid path");
  }
  const p = sanitizeName(path);
  const w = sanitizeName(workspaceName);
  const pr = sanitizeName(projectName);
  if (!w || !pr) {
    // fallback legacy nếu chưa truyền đủ workspace/project
    return p;
  }
  return `${p}.${w}.${pr}`;
}

async function mongoFindOneByPath(path, workspaceName, projectName) {
  const col = getCollection(toCollectionName(path, workspaceName, projectName));
  return await col.findOne({});
}

async function mongoDeleteAllByPath(path, workspaceName, projectName) {
  const col = getCollection(toCollectionName(path, workspaceName, projectName));
  const r = await col.deleteMany({});
  return r.deletedCount > 0;
}

async function mongoUpsertEmptyIfMissing(path, workspaceName, projectName) {
  const col = getCollection(toCollectionName(path, workspaceName, projectName));
  await col.updateOne({}, { $setOnInsert: { data_default: [], data_current: [] } }, { upsert: true });
}

// ------------------------
// Core queries (Postgres)
// ------------------------
async function findById(id) {
  const { rows } = await statefulPool.query("SELECT id, origin_id, folder_id, name, method, path, is_active, schema, created_at, updated_at FROM endpoints_ful WHERE id = $1", [id]);
  return rows[0] || null;
}

async function findByFolderId(folderId) {
  const { rows } = await statefulPool.query("SELECT id, origin_id, folder_id, name, method, path, is_active, schema, created_at, updated_at FROM endpoints_ful WHERE folder_id = $1 ORDER BY created_at DESC", [folderId]);
  return rows;
}

/**
 * Paginated list for endpoints within a folder with optional search/filter/sort
 * opts: { page, limit, query, filter: object, sort: { field, dir } }
 * returns { rows, total }
 */
async function findByFolderIdPaged(folderId, opts = {}) {
  const page = Number.isFinite(Number(opts.page)) ? Math.max(1, Number(opts.page)) : 1;
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(500, Number(opts.limit))) : 20;
  const offset = (page - 1) * limit;

  const allowedFilterFields = new Set(["id", "origin_id", "name", "method", "path", "is_active"]);
  const allowedSortFields = new Set(["id", "name", "method", "path", "created_at", "updated_at", "is_active"]);

  const where = ["folder_id = $1"];
  const params = [folderId];
  let idx = 2;

  if (opts.query && String(opts.query).trim()) {
    where.push(`(name ILIKE $${idx} OR path ILIKE $${idx})`);
    params.push(`%${String(opts.query).trim()}%`);
    idx++;
  }

  if (opts.filter && typeof opts.filter === "object") {
    for (const [k, v] of Object.entries(opts.filter)) {
      if (!allowedFilterFields.has(k)) continue;
      where.push(`${k} = $${idx}`);
      params.push(v);
      idx++;
    }
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // sort
  let orderClause = "ORDER BY created_at DESC";
  if (opts.sort && opts.sort.field) {
    const f = String(opts.sort.field);
    const dir = String(opts.sort.dir || "asc").toUpperCase() === "DESC" ? "DESC" : "ASC";
    const field = allowedSortFields.has(f) ? f : null;
    if (field) orderClause = `ORDER BY ${field} ${dir}`;
  }

  // total
  const qTotal = `SELECT COUNT(*)::int AS cnt FROM endpoints_ful ${whereClause}`;
  const { rows: totalRows } = await statefulPool.query(qTotal, params);
  const total = Number(totalRows[0]?.cnt || 0);

  // data
  const q = `SELECT id, origin_id, folder_id, name, method, path, is_active, schema, created_at, updated_at FROM endpoints_ful ${whereClause} ${orderClause} LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);
  const { rows } = await statefulPool.query(q, params);

  return { rows, total };
}

async function getFullDetailById(id) {
  const [endpoint, responses] = await Promise.all([findById(id), ResponseStatefulService.findByEndpointId(id)]);
  if (!endpoint) return null;

  // 🔁 Sắp xếp schema theo schema_order (nếu có) để API trả về đúng thứ tự FE đã PUT
  // Trả thẳng schema từ DB; không dùng schema_order nữa
  return { ...endpoint, is_stateful: true, responses: responses || [] };
}

// Xoá endpoint stateful + responses (Postgres) và data (Mongo)
async function deleteById(id) {
  const client = await statefulPool.connect();
  try {
    await client.query("BEGIN");

    const { rows: epRows } = await client.query("SELECT path, origin_id FROM endpoints_ful WHERE id = $1", [id]);
    const ep = epRows[0];
    if (!ep) {
      await client.query("ROLLBACK");
      return { success: false, notFound: true };
    }
    const originIdBeforeDelete = ep.origin_id || null;
    await client.query("DELETE FROM endpoint_responses_ful WHERE endpoint_id = $1", [id]);
    await client.query("DELETE FROM endpoints_ful WHERE id = $1", [id]);

    await client.query("COMMIT");

    // Mongo delete (ngoài transaction)
    if (ep.path) {
      // tìm workspace/project theo origin_id (đã lưu trước khi xoá)
      let workspaceName = "Workspace",
        projectName = "Project";
      if (originIdBeforeDelete) {
        const { rows } = await statelessPool.query(
          `SELECT w.name AS workspace_name, p.name AS project_name
             FROM endpoints e
             JOIN folders f  ON f.id = e.folder_id
             JOIN projects p ON p.id = f.project_id
             JOIN workspaces w ON w.id = p.workspace_id
            WHERE e.id = $1 LIMIT 1`,
          [originIdBeforeDelete]
        );
        workspaceName = rows[0]?.workspace_name || workspaceName;
        projectName = rows[0]?.project_name || projectName;
      }
      await mongoDeleteAllByPath(ep.path, workspaceName, projectName);
    }

    return { success: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function findByOriginId(originId) {
  const { rows } = await statefulPool.query("SELECT id FROM endpoints_ful WHERE origin_id = $1 LIMIT 1", [originId]);
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
    const {
      rows: [endpoint],
    } = await clientStateless.query("SELECT * FROM endpoints WHERE id = $1", [endpointId]);
    if (!endpoint) throw new Error("Stateless endpoint not found");

    // 🔍 Kiểm tra base_schema của folder trước khi cho phép chuyển đổi
    const {
      rows: [folderCheck],
    } = await clientStateless.query(`SELECT base_schema FROM folders WHERE id = $1 LIMIT 1`, [endpoint.folder_id]);

    if (!folderCheck || folderCheck.base_schema === null) {
      throw new Error(JSON.stringify({ message: "Folder does not have a base schema" }));
    }

    // 2) đã có stateful trước đó chưa?
    const { rows: existing } = await clientStateful.query("SELECT id, is_active, path, method FROM endpoints_ful WHERE origin_id = $1 LIMIT 1", [endpoint.id]);

    if (existing.length > 0) {
      const statefulId = existing[0].id;

      await clientStateful.query("UPDATE endpoints_ful SET is_active = TRUE, updated_at = NOW() WHERE id = $1", [statefulId]);
      await clientStateless.query("UPDATE endpoints SET is_stateful = TRUE, is_active = FALSE, updated_at = NOW() WHERE id = $1", [endpointId]);

      await clientStateful.query("COMMIT");
      await clientStateless.query("COMMIT");

      // Đảm bảo Mongo + default responses
      await ensureDefaultsForReactivate(statefulId, existing[0].path ?? endpoint.path, existing[0].method ?? endpoint.method);

      return { stateful_id: statefulId };
    }

    // ► Lấy project_name & workspace_name để đặt collection
    const { rows: wpRows } = await clientStateless.query(
      `SELECT w.name AS workspace_name, p.name AS project_name
         FROM endpoints e
         JOIN folders f  ON f.id = e.folder_id
         JOIN projects p ON p.id = f.project_id
         JOIN workspaces w ON w.id = p.workspace_id
        WHERE e.id = $1
        LIMIT 1`,
      [endpointId]
    );
    const workspaceName = wpRows[0]?.workspace_name || "Workspace";
    const projectName = wpRows[0]?.project_name || "Project";

    // 3) convert lần đầu
    await clientStateless.query("UPDATE endpoints SET is_stateful = TRUE, is_active = FALSE, updated_at = NOW() WHERE id = $1", [endpointId]);

    const {
      rows: [statefulEndpoint],
    } = await clientStateful.query(
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
    const {
      rows: [folder],
    } = await clientStateless.query(
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

    // Tạo default responses + khởi tạo collection Mongo trống (gắn WS/Project)
    const responsesResult = await generateDefaultResponses(statefulEndpoint);
    await mongoUpsertEmptyIfMissing(statefulEndpoint.path, workspaceName, projectName);

    return {
      stateless: endpoint,
      stateful: statefulEndpoint,
      responses: responsesResult,
      mongo_collection: toCollectionName(statefulEndpoint.path, workspaceName, projectName),
    };
  } catch (e) {
    try {
      await clientStateless.query("ROLLBACK");
    } catch { }
    try {
      await clientStateful.query("ROLLBACK");
    } catch { }
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

    const { rows: existing } = await clientStateful.query("SELECT id FROM endpoints_ful WHERE origin_id = $1 LIMIT 1", [endpointId]);
    if (existing.length > 0) {
      await clientStateful.query("UPDATE endpoints_ful SET is_active = FALSE, updated_at = NOW() WHERE id = $1", [existing[0].id]);
    }

    await clientStateless.query("UPDATE endpoints SET is_stateful = FALSE, is_active = TRUE, updated_at = NOW() WHERE id = $1", [endpointId]);

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
  // Truy ngược để biết workspace/project theo origin_id
  const { rows: epRows } = await statefulPool.query(`SELECT origin_id FROM endpoints_ful WHERE id=$1 LIMIT 1`, [statefulId]);
  const originId = epRows[0]?.origin_id;
  let workspaceName = "Workspace",
    projectName = "Project";
  if (originId) {
    const { rows } = await statelessPool.query(
      `SELECT w.name AS workspace_name, p.name AS project_name
         FROM endpoints e
         JOIN folders f  ON f.id = e.folder_id
         JOIN projects p ON p.id = f.project_id
         JOIN workspaces w ON w.id = p.workspace_id
        WHERE e.id = $1
        LIMIT 1`,
      [originId]
    );
    workspaceName = rows[0]?.workspace_name || workspaceName;
    projectName = rows[0]?.project_name || projectName;
  }
  await mongoUpsertEmptyIfMissing(path, workspaceName, projectName);

  const { rows: respRows } = await statefulPool.query("SELECT 1 FROM endpoint_responses_ful WHERE endpoint_id = $1 LIMIT 1", [statefulId]);
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
        [endpointId, res.name, res.status_code, JSON.stringify(res.response_body ?? {}), res.delay_ms || 0]
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
    {
      name: "Get Detail Not Found",
      status_code: 404,
      response_body: { message: `${R} with id {{params.id}} not found.` },
    },
  ];
  return insertResponses(endpointId, responses);
}

async function ResponsesForPOST(endpointId, endpointPath) {
  const R = capitalizeFromPath(endpointPath);
  const responses = [
    {
      name: "Create Success",
      status_code: 201,
      response_body: { message: `New ${R} item added successfully.` },
    },
    {
      name: "Schema Invalid",
      status_code: 400,
      response_body: {
        message: `Invalid data: request does not match ${R} object schema.`,
      },
    },
    {
      name: "ID Conflict",
      status_code: 409,
      response_body: {
        message: `${R} {{params.id}} conflict: {{params.id}} already exists.`,
      },
    },
  ];
  return insertResponses(endpointId, responses);
}

async function ResponsesForPUT(endpointId, endpointPath) {
  const R = capitalizeFromPath(endpointPath);
  const responses = [
    {
      name: "Update Success",
      status_code: 200,
      response_body: {
        message: `${R} with id {{params.id}} updated successfully.`,
      },
    },
    {
      name: "Schema Invalid",
      status_code: 400,
      response_body: {
        message: `Invalid data: request does not match ${R} schema.`,
      },
    },
    {
      name: "ID Conflict",
      status_code: 409,
      response_body: {
        message: `Update id {{params.id}} conflict: ${R} id {{params.id}} in request body already exists.`,
      },
    },
    {
      name: "Not Found",
      status_code: 404,
      response_body: { message: `${R} with id {{params.id}} not found.` },
    },
  ];
  return insertResponses(endpointId, responses);
}

async function ResponsesForDELETE(endpointId, endpointPath) {
  const R = capitalizeFromPath(endpointPath);
  const responses = [
    {
      name: "Delete All Success",
      status_code: 200,
      response_body: { message: `Delete all data with ${R} successfully.` },
    },
    {
      name: "Delete Success",
      status_code: 200,
      response_body: {
        message: `${R} with id {{params.id}} deleted successfully.`,
      },
    },
    {
      name: "Not Found",
      status_code: 404,
      response_body: {
        message: `${R} with id {{params.id}} to delete not found.`,
      },
    },
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
    const {
      rows: [response],
    } = await client.query("SELECT * FROM endpoint_responses_ful WHERE id = $1", [responseId]);
    if (!response) throw new Error("Response not found");
    if (response.status_code === 200 && (response.name === "Get All Success" || response.name === "Get Detail Success")) {
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
    const {
      rows: [updated],
    } = await client.query(
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

async function getEndpointData(path, opts = {}) {
  const { workspaceName = null, projectName = null } = opts || {};
  if (!path) throw new Error("Thiếu path");
  const pgPath = path.startsWith("/") ? path : "/" + path;
  const { rows } = await statefulPool.query("SELECT id FROM endpoints_ful WHERE path = $1 LIMIT 1", [pgPath]);
  if (rows.length === 0) {
    throw new Error(`Không tìm thấy endpoints_ful với path: ${pgPath}`);
  }
  return await mongoFindOneByPath(pgPath, workspaceName, projectName);
}
async function updateEndpointData(path, body, opts = {}) {
  const { workspaceName = null, projectName = null } = opts || {};
  if (!body) throw new Error("Body không hợp lệ hoặc thiếu");
  const { schema, data_default } = body;

  // Lấy row endpoints_ful theo path (kèm schema_order để giữ đúng thứ tự)
  const pgPath = path.startsWith("/") ? path : "/" + path;
  const { rows } = await statefulPool.query("SELECT id, schema FROM endpoints_ful WHERE path = $1 LIMIT 1", [pgPath]);
  if (rows.length === 0) throw new Error("Không tìm thấy endpoints_ful với path: " + pgPath);
  const currentSchema = rows[0].schema || {};

  // Helpers validate (giữ tinh gọn)
  const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  const orderedSchemaKeys = (sch) => {
    if (sch && Array.isArray(sch.__order)) return sch.__order.slice();
    return Object.keys(sch || {}).filter((k) => k !== "__order");
  };
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
      return {
        ok: false,
        reason: `Thứ tự/trường không khớp schema. Schema: [${sKeys.join(", ")}], Data: [${Object.keys(obj).join(", ")}]`,
      };
    }
    for (const key of sKeys) {
      const rule = sch[key];
      const value = obj[key];
      const isMissing = value === undefined;
      if (rule.required && isMissing) return { ok: false, reason: `Thiếu trường bắt buộc: "${key}"` };
      if (!isMissing) {
        const jsType = typeOf(value);
        const ok = (rule.type === "number" && jsType === "number") || (rule.type === "string" && jsType === "string") || (rule.type === "boolean" && jsType === "boolean") || (rule.type === "object" && jsType === "object") || (rule.type === "array" && jsType === "array");
        if (!ok)
          return {
            ok: false,
            reason: `Sai kiểu "${key}". Mong đợi: ${rule.type}, thực tế: ${jsType}`,
          };
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
      if (!r.ok)
        return {
          ok: false,
          reason: `Phần tử thứ ${i} không hợp lệ: ${r.reason}`,
        };
    }
    const u = ensureUniqueIdsIfPresent(dataArr);
    if (!u.ok) return u;
    return { ok: true };
  };

  // 1) Cả schema + data_default → chuẩn hoá schema (ép 'id'), validate + ghi Mongo
  if (schema && data_default) {
    if (typeof schema !== "object" || Array.isArray(schema)) throw new Error("schema phải là object (map field -> rule)");
    if (!Array.isArray(data_default)) throw new Error("data_default phải là mảng object");

    // dùng nguyên schema FE gửi; không tự thêm 'id'
    const cloned = JSON.parse(JSON.stringify(data_default));
    const withIds = autoAssignIdsIfAllowed(cloned, schema);
    const v = validateArrayWithSchema(withIds, schema);

    if (!v.ok) throw new Error(`Dữ liệu không khớp schema: ${v.reason}`);

    await statefulPool.query("UPDATE endpoints_ful SET schema = $1, updated_at = NOW() WHERE path = $2", [JSON.stringify(schema), pgPath]);

    const col = getCollection(toCollectionName(path, workspaceName, projectName));
    await col.updateOne({}, { $set: { data_default: withIds, data_current: withIds } }, { upsert: true });
    return await mongoFindOneByPath(path, workspaceName, projectName);
  }

  // 2) Chỉ schema → chuẩn hoá + cập nhật PG; KHÔNG động vào Mongo
  if (schema && !data_default) {
    if (typeof schema !== "object" || Array.isArray(schema)) throw new Error("schema phải là object (map field -> rule)");
    await statefulPool.query("UPDATE endpoints_ful SET schema = $1, updated_at = NOW() WHERE path = $2", [JSON.stringify(schema), pgPath]);
    return await findByPathPG(path);
  }

  // 3) Chỉ data_default → KHÔNG cần theo schema; chấp nhận object hoặc mảng các object
  if (!schema && data_default) {
    // Ép về mảng object
    const payload = Array.isArray(data_default) ? data_default : [data_default];
    if (!payload.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      throw new Error("data_default phải là object hoặc mảng các object.");
    }
    // Ghi thẳng vào Mongo, không auto-assign id, không validate theo schema
    const col = getCollection(toCollectionName(path, workspaceName, projectName));
    await col.updateOne({}, { $set: { data_default: payload, data_current: payload } }, { upsert: true });
    return await mongoFindOneByPath(path, workspaceName, projectName);
  }

  throw new Error("Payload phải có ít nhất một trong hai: schema hoặc data_default");
}

// tiện ích nhỏ để trả hàng PG theo path (khi chỉ sửa schema)
async function findByPathPG(path) {
  const { rows } = await statefulPool.query("SELECT id, origin_id, folder_id, name, method, path, is_active, schema, created_at, updated_at FROM endpoints_ful WHERE path = $1 LIMIT 1", [path]);
  if (rows.length === 0) return null;
  return rows[0];
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
// Lấy base_schema qua endpointId; thêm required nếu method là POST/PUT
async function getBaseSchemaByEndpointId(statelessPool, endpointId) {
  // 1) Lấy folder_id + method từ endpoints
  const { rows: endpointRows } = await statelessPool.query(`SELECT folder_id, method FROM endpoints WHERE id = $1 LIMIT 1`, [endpointId]);
  if (endpointRows.length === 0) throw new Error("Endpoint not found");

  const folderId = endpointRows[0].folder_id;
  const method = String(endpointRows[0].method || "GET").toUpperCase();
  const isMutating = method === "POST" || method === "PUT";

  // 2) Lấy base_schema (kiểu dữ liệu: JSON/JSONB hoặc TEXT JSON)
  const { rows: folderRows } = await statelessPool.query(`SELECT base_schema FROM folders WHERE id = $1 LIMIT 1`, [folderId]);
  if (folderRows.length === 0) throw new Error("Folder not found");

  let schemaObj = folderRows[0].base_schema ?? null;
  if (!schemaObj) return { fields: [] };

  // Hỗ trợ trường hợp cột là TEXT chứa JSON
  if (typeof schemaObj === "string") {
    try {
      schemaObj = JSON.parse(schemaObj);
    } catch {
      return { fields: [] };
    }
  }

  if (typeof schemaObj !== "object" || Array.isArray(schemaObj)) {
    return { fields: [] };
  }

  // 3) Map fields: luôn có name + type; chỉ thêm required khi POST/PUT
  const fields = Object.entries(schemaObj).map(([name, def]) => {
    const t = def && typeof def === "object" ? def.type : undefined;
    const type = t || "string"; // ✅ Giữ nguyên "number" thay vì đổi thành "integer"
    if (isMutating) {
      const required = !!(def && typeof def === "object" && def.required === true);
      return { name, type, required };
    }
    return { name, type };
  });
  ;

  return { fields };
}

/**
 * Batch cleanup for STATEFUL side by stateless endpoint IDs (origin_ids):
 * - Delete endpoint_responses_ful
 * - Delete endpoints_ful
 * - Drop Mongo collection tương ứng path (best-effort, idempotent)
 */
async function deleteByOriginIds(originIds = []) {
  const ids = Array.from(new Set((originIds || []).map(Number))).filter(Number.isInteger);
  if (ids.length === 0) return { statefulEndpoints: 0, mongoDropped: 0 };

  // 1) Resolve names from stateless to keep Mongo naming consistent
  const { rows: nameRows } = await statelessPool.query(
    `SELECT e.id AS origin_id, w.name AS workspace_name, p.name AS project_name
       FROM endpoints e
       JOIN folders f  ON f.id = e.folder_id
       JOIN projects p ON p.id = f.project_id
       JOIN workspaces w ON w.id = p.workspace_id
      WHERE e.id = ANY($1::int[])`,
    [ids]
  );
  const nameMap = new Map(nameRows.map((r) => [r.origin_id, { ws: r.workspace_name, pj: r.project_name }]));

  // 2) Load endpoints_ful and paths in STATEFUL PG
  const { rows: sfRows } = await statefulPool.query(`SELECT id, origin_id, path FROM endpoints_ful WHERE origin_id = ANY($1::int[])`, [ids]);
  const statefulIds = sfRows.map((r) => r.id);

  // 3) Delete STATEFUL PG in a tx: responses first, then endpoints_ful
  await statefulPool.query("BEGIN");
  try {
    if (statefulIds.length > 0) {
      await statefulPool.query(`DELETE FROM endpoint_responses_ful WHERE endpoint_id = ANY($1::int[])`, [statefulIds]);
      await statefulPool.query(`DELETE FROM endpoints_ful WHERE id = ANY($1::int[])`, [statefulIds]);
    }
    await statefulPool.query("COMMIT");
  } catch (e) {
    await statefulPool.query("ROLLBACK");
    throw e;
  }

  // 4) Best-effort Mongo: drop collection theo path qua helper mới
  let dropped = 0;
  for (const r of sfRows) {
    if (!r.path) continue;
    try {
      const res = await dropCollectionByPath(r.path);
      if (res?.dropped) dropped++;
    } catch (_) {
      // ignore to keep idempotency
    }
  }

  return { statefulEndpoints: statefulIds.length, mongoDropped: dropped };
}

// 🔹 Lấy bản ghi stateful bằng origin_id (raw)
async function findByOriginIdRaw(originId) {
  const { rows } = await statefulPool.query(
    "SELECT id, origin_id, advanced_config FROM endpoints_ful WHERE origin_id = $1 LIMIT 1",
    [originId]
  );
  return rows[0] || null;
}

// 🔹 Cập nhật advanced_config theo origin_id
async function updateAdvancedConfigByOriginId(originId, advancedConfigObj) {
  const { rows } = await statefulPool.query(
    "UPDATE endpoints_ful SET advanced_config = $1, updated_at = NOW() WHERE origin_id = $2 RETURNING id, origin_id, advanced_config",
    [advancedConfigObj, originId]
  );

  if (rows.length === 0) {
    return { notFound: true };
  }

  return rows[0];
}

// ------------------------
// Exports (function-based)
// ------------------------
module.exports = {
  findById,
  findByFolderId,
  getFullDetailById,
  deleteById,
  deleteByOriginIds,
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
  getEndpointData,
  getEndpointSchema,
  getBaseSchemaByEndpointId,
  findByOriginIdRaw,
  updateAdvancedConfigByOriginId,
};
