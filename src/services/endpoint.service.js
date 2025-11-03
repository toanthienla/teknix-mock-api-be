const logSvc = require("./project_request_log.service");
const endpointResponseService = require("./endpoint_response.service");

// Get all endpoints (optionally filter by project_id OR folder_id)
async function getEndpoints(dbPool, { project_id, folder_id } = {}) {
  // Chọn tất cả các cột từ bảng endpoints
  let query = `
    SELECT e.id, e.folder_id, e.name, e.method, e.path, e.is_active, e.is_stateful, e.created_at, e.updated_at 
    FROM endpoints e
  `;
  const params = [];
  let paramIndex = 1;

  // Nếu có project_id, chúng ta JOIN với bảng folders để lọc
  if (project_id) {
    query += ` JOIN folders f ON e.folder_id = f.id WHERE f.project_id = $${paramIndex++}`;
    params.push(project_id);
    if (folder_id) {
      query += ` AND e.folder_id = $${paramIndex++}`;
      params.push(folder_id);
    }
  } else if (folder_id) {
    query += ` WHERE e.folder_id = $${paramIndex++}`;
    params.push(folder_id);
  }
  // Nếu không có cả hai, không thêm điều kiện nào, trả về tất cả

  query += " ORDER BY e.created_at DESC";

  const { rows } = await dbPool.query(query, params);
  return { success: true, data: rows };
}

// Get endpoint by id
async function getEndpointById(dbPool, endpointId) {
  const { rows } = await dbPool.query("SELECT * FROM endpoints WHERE id=$1 LIMIT 1", [endpointId]);
  return rows[0] || null;
}

// Create endpoint
// services/endpoint.service.js
async function createEndpoint(dbPool, { folder_id, name, method, path, is_active, is_stateful }) {
  const errors = [];

  // 0) Kiểm tra folder_id hợp lệ và lấy project_id
  const { rows: folderRows } = await dbPool.query(`SELECT id, project_id FROM folders WHERE id = $1`, [folder_id]);
  const folder = folderRows[0];
  if (!folder) {
    return {
      success: false,
      errors: [{ field: "folder_id", message: "Folder not found" }],
    };
  }
  const projectId = folder.project_id;

  // 1) Check duplicate NAME trong CÙNG PROJECT (ignore case)
  const { rows: nameRows } = await dbPool.query(
    `
    SELECT e.id
    FROM endpoints e
    JOIN folders f ON f.id = e.folder_id
    WHERE f.project_id = $1
      AND LOWER(e.name) = LOWER($2)
    LIMIT 1
    `,
    [projectId, name]
  );
  if (nameRows.length > 0) {
    errors.push({
      field: "name",
      message: "Name already exists in this project",
    });
  }

  // 2) Check PATH + METHOD theo PROJECT (path case-sensitive như cũ)
  const { rows: samePathRows } = await dbPool.query(
    `
    SELECT e.method
    FROM endpoints e
    JOIN folders f ON f.id = e.folder_id
    WHERE f.project_id = $1
      AND e.path = $2
    `,
    [projectId, path]
  );

  const usedMethods = samePathRows.map((r) => String(r.method || "").toUpperCase());
  const methodUpper = String(method || "").toUpperCase();

  if (usedMethods.includes(methodUpper)) {
    errors.push({
      field: "method",
      message: "Method already exists for this path in this project",
    });
  }
  if (!usedMethods.includes(methodUpper) && usedMethods.length >= 4) {
    errors.push({
      field: "path",
      message: "Path already has all 4 methods in this project",
    });
  }

  if (errors.length > 0) return { success: false, errors };

  // 3) Giá trị mặc định
  const final_is_active = is_active === undefined ? true : is_active;
  const final_is_stateful = is_stateful === undefined ? false : is_stateful;

  // 4) Tạo endpoint
  const { rows } = await dbPool.query(
    `
    INSERT INTO endpoints (folder_id, name, method, path, is_active, is_stateful)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
    `,
    [folder_id, name, methodUpper, path, final_is_active, final_is_stateful]
  );
  const endpoint = rows[0];

  // 5) Nếu endpoint tạo ở chế độ STATEFUL, gắn bản ghi meta ở endpoints_ful theo endpoint_id
  if (endpoint.is_stateful === true) {
    await dbPool.query(
      `INSERT INTO endpoints_ful (endpoint_id, is_active)
       VALUES ($1, TRUE)
       ON CONFLICT (endpoint_id) DO NOTHING`,
      [endpoint.id]
    );
  }

  // 6) Auto-create default endpoint_response (STATeless)
  await endpointResponseService.create(dbPool, {
    endpoint_id: endpoint.id,
    name: "Success",
    status_code: 200,
    response_body: { success: true },
    condition: {},
    is_default: true,
    delay_ms: 0,
  });

  return { success: true, data: endpoint };
}

// ==============================
// Update Endpoint (Stateless + Stateful)
// ==============================
async function updateEndpoint(clientStateless, clientStateful, endpointId, payload) {
  const keys = Object.keys(payload || {});
  if (keys.length === 0) {
    return { success: false, message: "No data provided to update." };
  }

  // ✅ Chỉ cho phép 1 field: name hoặc schema
  if (keys.length > 1 || !["name", "schema"].includes(keys[0])) {
    return { success: false, message: "Only one field ('name' or 'schema') can be updated at a time." };
  }

  const field = keys[0];
  const value = payload[field];

  // 1️⃣ Lấy endpoint để xác định loại (một DB hợp nhất → dùng clientStateless)
  const { rows: epRows } = await clientStateless.query("SELECT * FROM endpoints WHERE id = $1", [endpointId]);
  const endpoint = epRows[0];
  if (!endpoint) return { success: false, message: "Endpoint not found." };

  const { is_active, is_stateful, folder_id } = endpoint;

  // 2️⃣ Xác định loại endpoint (đúng theo schema mới)
  const isStateless = is_stateful === false;
  const isStateful = is_stateful === true;

  if (!isStateless && !isStateful) {
    return { success: false, message: "Invalid endpoint state. Cannot determine stateless or stateful." };
  }

  // ============================
  // 🔹 CASE 1: Stateless
  // ============================
  if (isStateless) {
    if (field !== "name") {
      return { success: false, message: "Stateless endpoints only allow updating the name." };
    }

    // 🔄 Kiểm tra trùng name trong CÙNG PROJECT (nhất quán với create)
    const { rows: dupRows } = await clientStateless.query(
      `SELECT e.id
         FROM endpoints e
         JOIN folders f ON f.id = e.folder_id
        WHERE f.project_id = (SELECT project_id FROM folders WHERE id = $1)
          AND LOWER(e.name) = LOWER($2)
          AND e.id <> $3`,
      [folder_id, value, endpointId]
    );
    if (dupRows.length > 0) {
      return { success: false, message: "An endpoint with this name already exists in this project." };
    }

    // Update name
    const { rows: updatedRows } = await clientStateless.query("UPDATE endpoints SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING *", [value, endpointId]);
    return { success: true, data: updatedRows[0] };
  }

  // ============================
  // 🔹 CASE 2: Stateful
  // ============================
  if (isStateful) {
    // Lấy meta stateful theo endpoint_id
    const { rows: sfRows } = await clientStateless.query("SELECT * FROM endpoints_ful WHERE endpoint_id = $1", [endpointId]);
    const statefulEp = sfRows[0];
    if (!statefulEp) return { success: false, message: "Stateful endpoint not found." };

    // Nếu update name → kiểm tra trùng name trong folder tương ứng (trên bảng endpoints)
    if (field === "name") {
      // 🔄 Kiểm tra trùng name trong CÙNG PROJECT (nhất quán với create)
      const { rows: dupRows } = await clientStateless.query(
        `SELECT e.id
           FROM endpoints e
           JOIN folders f ON f.id = e.folder_id
          WHERE f.project_id = (SELECT project_id FROM folders WHERE id = $1)
            AND LOWER(e.name) = LOWER($2)
            AND e.id <> $3`,
        [folder_id, value, endpointId]
      );
      if (dupRows.length > 0) {
        return { success: false, message: "An endpoint with this name already exists in this project." };
      }
      // Name thuộc bảng endpoints → cập nhật ở endpoints
      const { rows: updatedRows } = await clientStateless.query("UPDATE endpoints SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING *", [value, endpointId]);
      return { success: true, data: updatedRows[0] };
    }

    if (field === "schema") {
      if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
        return { success: false, message: "Invalid schema format." };
      }
      const { rows: updatedRows } = await clientStateless.query(
        `UPDATE endpoints_ful
            SET schema = $1::jsonb,
                updated_at = NOW()
          WHERE endpoint_id = $2
        RETURNING *`,
        [JSON.stringify(value), endpointId]
      );
      return { success: true, data: updatedRows[0] };
    }

    return { success: false, message: "No valid field to update." };
  }

  return { success: false, message: "Unexpected endpoint state." };
}

// Delete endpoint
async function deleteEndpoint(dbPool, endpointId) {
  const endpoint = await getEndpointById(dbPool, endpointId);
  if (!endpoint) return null;

  // dùng 1 transaction để đảm bảo tính nhất quán
  await dbPool.query("BEGIN");
  try {
    // 1) Nếu là stateful, xóa dữ liệu liên quan ở bảng _ful theo endpoint_id
    if (endpoint.is_stateful === true) {
      // 🛡️ Null hoá stateful_* trong logs TRƯỚC khi xoá endpoints_ful
      await dbPool.query(
        `UPDATE project_request_logs
            SET stateful_endpoint_id = NULL,
                stateful_endpoint_response_id = NULL
          WHERE stateful_endpoint_id IN (
                SELECT id FROM endpoints_ful WHERE endpoint_id = $1
          )`,
        [endpointId]
      );
      // Sau đó xoá responses_ful
      await dbPool.query(
        `DELETE FROM endpoint_responses_ful
          WHERE endpoint_id IN (SELECT id FROM endpoints_ful WHERE endpoint_id = $1)`,
        [endpointId]
      );
      // Và xoá meta endpoints_ful
      await dbPool.query(`DELETE FROM endpoints_ful WHERE endpoint_id = $1`, [endpointId]);
    }

    // 2) Nullify notifications ràng buộc tới endpoint này
    //    (theo yêu cầu: set NULL cho cả 3 cột)
    await dbPool.query(
      `
        UPDATE notifications
           SET project_request_log_id = NULL,
               endpoint_id = NULL,
               user_id = NULL
        WHERE endpoint_id = $1
      `,
      [endpointId]
    );

    // 3) Nullify logs + xóa endpoint_responses

    await logSvc.nullifyEndpointAndResponses(dbPool, endpointId);

    // 4) Xóa endpoint gốc
    await dbPool.query("DELETE FROM endpoints WHERE id=$1", [endpointId]);

    await dbPool.query("COMMIT");
    return { success: true, data: endpoint };
  } catch (err) {
    await dbPool.query("ROLLBACK");
    throw err;
  }
}

async function setSendNotification(dbPool, endpointId, enable) {
  return {
    success: false,
    message: "send_notification is not available on current schema. Add column endpoints.send_notification or move flag to responses.",
  };
}

module.exports = {
  getEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  setSendNotification,
};
