//const db = require("../config/db");
const endpointResponseService = require("./endpoint_response.service"); // import service response
const statefulEndpointSvc = require("./endpoints_ful.service");
const logSvc = require("./project_request_log.service");

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

    // Nếu không có project_id nhưng có folder_id, lọc trực tiếp
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

  // 5) Auto-create default endpoint_response
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

  // 1️⃣ Lấy endpoint từ DB stateless để xác định loại
  const { rows: epRows } = await clientStateless.query("SELECT * FROM endpoints WHERE id = $1", [endpointId]);
  const endpoint = epRows[0];
  if (!endpoint) return { success: false, message: "Endpoint not found." };

  const { is_active, is_stateful, folder_id, name: oldName } = endpoint;

  // 2️⃣ Xác định loại endpoint
  const isStateless = is_active === true && is_stateful === false;
  const isStateful = is_active === false && is_stateful === true;

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

    // Kiểm tra trùng name trong cùng folder
    const { rows: dupRows } = await clientStateless.query(
      "SELECT id FROM endpoints WHERE folder_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3",
      [folder_id, value, endpointId]
    );
    if (dupRows.length > 0) {
      return { success: false, message: "An endpoint with this name already exists in the folder." };
    }

    // Update name
    const { rows: updatedRows } = await clientStateless.query(
      "UPDATE endpoints SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [value, endpointId]
    );
    return { success: true, data: updatedRows[0] };
  }

  // ============================
  // 🔹 CASE 2: Stateful
  // ============================
  if (isStateful) {
    // Lấy endpoint stateful theo origin_id
    const { rows: sfRows } = await clientStateful.query("SELECT * FROM endpoints_ful WHERE origin_id=$1", [endpointId]);
    const statefulEp = sfRows[0];
    if (!statefulEp) return { success: false, message: "Stateful endpoint not found." };

    // Nếu update name → kiểm tra trùng name trong folder tương ứng
    if (field === "name") {
      const { rows: dupRows } = await clientStateful.query(
        "SELECT id FROM endpoints_ful WHERE folder_id=$1 AND LOWER(name)=LOWER($2) AND origin_id<>$3",
        [folder_id, value, endpointId]
      );
      if (dupRows.length > 0) {
        return { success: false, message: "An endpoint with this name already exists in the folder." };
      }
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (field === "name") {
      updates.push(`name = $${idx++}`);
      values.push(value);
    }

    if (field === "schema") {
      if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
        return { success: false, message: "Invalid schema format." };
      }
      updates.push(`schema = $${idx++}::jsonb`);
      values.push(JSON.stringify(value));
    }

    if (updates.length === 0) {
      return { success: false, message: "No valid field to update." };
    }

    values.push(endpointId);

    const { rows: updatedRows } = await clientStateful.query(
      `
      UPDATE endpoints_ful
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE origin_id = $${idx}
      RETURNING *;
      `,
      values
    );

    return { success: true, data: updatedRows[0] };
  }

  return { success: false, message: "Unexpected endpoint state." };
}

// Delete endpoint
async function deleteEndpoint(dbPool, endpointId) {
  // Lấy thông tin endpoint để kiểm tra is_stateful
  const endpoint = await getEndpointById(dbPool, endpointId);
  if (!endpoint) return null;

  // Nếu là stateful, gọi service xóa của stateful
  if (endpoint.is_stateful === true) {
    // Tìm stateful endpoint bằng origin_id
    const statefulEndpoint = await statefulEndpointSvc.findByOriginId(endpoint.id);
    if (statefulEndpoint) {
      await statefulEndpointSvc.deleteById(statefulEndpoint.id);
    }
  }

  // Luôn thực hiện xóa cho stateless (xóa bản ghi gốc)
  // Logic cũ để null hóa log và xóa vẫn được giữ lại
  await logSvc.nullifyEndpointAndResponses(dbPool, endpointId);
  await dbPool.query("DELETE FROM endpoints WHERE id=$1", [endpointId]);

  return { success: true, data: endpoint };
}

module.exports = {
  getEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
};
