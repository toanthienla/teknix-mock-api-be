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

// Update endpoint (Stateless + Stateful)
async function updateEndpoint(clientStateless, clientStateful, endpointId, { name, method, path, is_active, is_stateful, schema }) {
  const errors = [];

  // 1️⃣ Lấy endpoint hiện tại từ DB stateless
  const { rows: currentRows } = await clientStateless.query("SELECT * FROM endpoints WHERE id=$1", [endpointId]);
  const current = currentRows[0];
  if (!current) return { success: false, message: "Endpoint not found" };

  // -----------------------------------------------------
  // 🔹 PHẦN 1: Logic cũ cho Stateless (is_stateful = false)
  // -----------------------------------------------------
  if (!current.is_stateful) {
    const newName = name ?? current.name;
    const newMethod = method ?? current.method;
    const newPath = path ?? current.path;
    let finalIsActive = is_active ?? current.is_active;
    let finalIsStateful = is_stateful ?? current.is_stateful;

    // QUY TẮC 1: Nếu stateful -> active = false
    if (finalIsStateful === true) {
      finalIsActive = false;
    }
    // QUY TẮC 2: Nếu vừa tắt stateful -> active = true
    else if (is_stateful === false && current.is_stateful === true) {
      finalIsActive = is_active ?? true;
    }

    // Nếu dữ liệu không thay đổi
    if (newName === current.name && newMethod === current.method && newPath === current.path && finalIsActive === current.is_active && finalIsStateful === current.is_stateful) {
      return { success: true, data: current };
    }

    // Kiểm tra trùng name
    if (newName.toLowerCase() !== current.name.toLowerCase()) {
      const { rows: nameRows } = await clientStateless.query("SELECT id FROM endpoints WHERE id<>$1 AND folder_id=$2 AND LOWER(name)=LOWER($3)", [endpointId, current.folder_id, newName]);
      if (nameRows.length > 0) {
        errors.push({
          field: "name",
          message: "Name already exists in this folder",
        });
      }
    }

    // Kiểm tra path + method
    if (newPath !== current.path || newMethod.toUpperCase() !== current.method.toUpperCase()) {
      const { rows: samePathRows } = await clientStateless.query("SELECT method FROM endpoints WHERE id<>$1 AND folder_id=$2 AND path=$3", [endpointId, current.folder_id, newPath]);

      const usedMethods = samePathRows.map((r) => r.method.toUpperCase());
      const newMethodUpper = newMethod.toUpperCase();

      if (usedMethods.includes(newMethodUpper)) {
        errors.push({
          field: "method",
          message: "Method already exists for this path",
        });
      }
      if (!usedMethods.includes(newMethodUpper) && usedMethods.length >= 4) {
        errors.push({
          field: "path",
          message: "Path already has all 4 methods",
        });
      }
    }

    if (errors.length > 0) return { success: false, errors };

    const { rows: updatedRows } = await clientStateless.query(
      `UPDATE endpoints 
       SET name=$1, method=$2, path=$3, is_active=$4, is_stateful=$5, updated_at=NOW() 
       WHERE id=$6 RETURNING *`,
      [newName, newMethod, newPath, finalIsActive, finalIsStateful, endpointId]
    );

    return { success: true, data: updatedRows[0] };
  }

  // -----------------------------------------------------
  // 🔹 PHẦN 2: Logic mới cho Stateful (is_stateful = true)
  // -----------------------------------------------------
  // Cho phép update khi endpoint đang stateful (kể cả active)
  if (current.is_stateful) {
    // ---  phân loại "shape" của schema ---
    let isGetSchema = false;
    let isRulesSchema = false;
    if (schema !== undefined && schema !== null && typeof schema === "object") {
      // GET schema: chỉ có { fields: [...] }
      const hasFields = Array.isArray(schema.fields);
      const keys = Object.keys(schema);
      isGetSchema = hasFields && keys.length === 1;
      // Rules schema: có ít nhất 1 value là object có 'type' hoặc 'required'
      isRulesSchema = Object.values(schema).some((v) => v && typeof v === "object" && ("type" in v || "required" in v));
      if (isGetSchema && isRulesSchema) {
        return {
          success: false,
          message: "Schema is ambiguous: use either {fields:[...]} for GET or a rules map for POST/PUT.",
        };
      }

      // ✅ RÀNG BUỘC THEO METHOD
      const m = String(current.method || "").toUpperCase();
      if (m === "GET" && !isGetSchema) {
        return {
          success: false,
          message: "For GET endpoints, schema must be {fields:[...]}.",
        };
      }
      if ((m === "POST" || m === "PUT") && !isRulesSchema) {
        return {
          success: false,
          message: "For POST/PUT endpoints, schema must be a rules map (with type/required).",
        };
      }
      // Các method khác (DELETE, PATCH, ...) → hiện không cho cập nhật schema
      if (!["GET", "POST", "PUT"].includes(m)) {
        return {
          success: false,
          message: `Updating schema is not supported for ${m} endpoints.`,
        };
      }
      // KHÔNG thêm __order vào schema để lưu DB (JSONB không bảo toàn thứ tự)
      // -> ta xử lý thứ tự ở bước "trả về" sau khi update (xem Controller)
    }
    const updateParts = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      updateParts.push(`name = $${idx++}`);
      values.push(name);
    }

    if (schema !== undefined) {
      updateParts.push(`schema = $${idx++}::jsonb`);
      values.push(JSON.stringify(schema));
    }

    if (updateParts.length === 0) {
      return { success: false, message: "No valid fields to update" };
    }

    values.push(endpointId);

    const updateQuery = `
      UPDATE endpoints_ful
      SET ${updateParts.join(", ")}, updated_at = NOW()
      WHERE origin_id = $${idx}
      RETURNING *;
    `;

    const { rows: updatedRows } = await clientStateful.query(updateQuery, values);
    const updated = updatedRows[0];

    // ---------------------------------------------
    // Nếu có schema mới → cập nhật base_schema (CHỈ với rules schema POST/PUT)
    // ---------------------------------------------
    // Nếu là rules schema (POST/PUT) → merge vào folders.base_schema:
    // - CHỈ THÊM field CHƯA CÓ
    // - KHÔNG XOÁ, KHÔNG GHI ĐÈ
    if (schema && isRulesSchema) {
      const { rows: folderRows } = await clientStateless.query("SELECT base_schema FROM folders WHERE id = $1", [current.folder_id]);
      // base_schema có thể null → mặc định {}
      let baseSchema = folderRows[0]?.base_schema || {};
      let baseChanged = false;

      // Thêm các field chưa có vào base_schema (không đụng field đã có)
      for (const [name, rule] of Object.entries(schema)) {
        // Không có __order nữa, nhưng vẫn phòng ngừa:
        if (name === "__order") continue;
        if (!Object.prototype.hasOwnProperty.call(baseSchema, name)) {
          const type = rule?.type ?? "string";
          const required = typeof rule?.required === "boolean" ? rule.required : true;
          baseSchema[name] = { type, required };
          baseChanged = true;
        }
      }

      if (baseChanged) {
        await clientStateless.query("UPDATE folders SET base_schema = $1::jsonb WHERE id = $2", [JSON.stringify(baseSchema), current.folder_id]);
      }
    }

    return { success: true, data: updated };
  }

  // -----------------------------------------------------
  // 🔹 PHẦN 3: Các trường hợp không đủ điều kiện update
  // -----------------------------------------------------
  return { success: false, message: "No valid fields to update" };
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
