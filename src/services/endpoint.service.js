const logSvc = require("./project_request_log.service");
const endpointResponseService = require("./endpoint_response.service");
const { pool: statelessPool } = require("../config/db");

// ==============================
// Helper: Capitalize path name
// ==============================
function capitalizeFromPath(endpointPath) {
  const seg = (endpointPath || "").split("/").filter(Boolean).pop() || "Resource";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

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

/**
 * Lấy websocket_config của endpoint theo id
 */
async function getWebsocketConfigById(id) {
  const sql = `SELECT id, websocket_config FROM endpoints WHERE id = $1 LIMIT 1`;
  const { rows } = await statelessPool.query(sql, [id]);
  if (rows.length === 0) return null;
  return rows[0];
}

/**
 * Cập nhật websocket_config (ghi đè toàn bộ object)
 */
async function updateWebsocketConfigById(id, config) {
  const sql = `
    UPDATE endpoints
    SET websocket_config = $2::jsonb, updated_at = NOW()
    WHERE id = $1
    RETURNING id, websocket_config
  `;
  const { rows } = await statelessPool.query(sql, [id, JSON.stringify(config)]);
  return rows[0] || null;
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
// Helper: Detect if path has query params or route params
// ==============================
function hasQueryOrRouteParams(path) {
  if (!path) return false;
  // Check for query params (?) or route params (: like :id, :userId)
  return /[?:]/.test(path);
}

// ==============================
// Update Endpoint (Stateless + Stateful)
// ==============================
async function updateEndpoint(clientStateless, clientStateful, endpointId, payload) {
  const keys = Object.keys(payload || {});
  if (keys.length === 0) {
    return { success: false, message: "No data provided to update." };
  }

  // ✅ Validation: cho phép group fields sau:
  // - Group 1: { name, path } hoặc subset của chúng
  // - Group 2: { schema } riêng
  // - Group 3: { websocket_config } riêng
  const allowedMetaFields = new Set(["name", "path"]);
  const allowedUpdateFields = new Set(["name", "path", "schema", "websocket_config"]);
  
  // Check tất cả keys hợp lệ
  const validKeys = keys.filter(k => allowedUpdateFields.has(k));
  if (validKeys.length !== keys.length) {
    return { success: false, message: `Invalid fields. Allowed: name, path, schema, websocket_config` };
  }

  // Check không mix schema với meta fields (name, path)
  if (keys.includes("schema") && (keys.includes("name") || keys.includes("path"))) {
    return { success: false, message: "Cannot update schema together with name/path. Please update them separately." };
  }

  // Check không mix websocket_config với meta fields (name, path)
  if (keys.includes("websocket_config") && (keys.includes("name") || keys.includes("path"))) {
    return { success: false, message: "Cannot update websocket_config together with name/path. Please update them separately." };
  }

  const field = keys[0];
  const value = payload[field];

  // 1️⃣ Lấy endpoint để xác định loại (một DB hợp nhất → dùng clientStateless)
  const { rows: epRows } = await clientStateless.query("SELECT * FROM endpoints WHERE id = $1", [endpointId]);
  const endpoint = epRows[0];
  if (!endpoint) return { success: false, message: "Endpoint not found." };

  const { is_active, is_stateful, folder_id } = endpoint;

  // 🔍 Handle websocket_config separately (applies to both stateless/stateful)
  if (keys.includes("websocket_config") && keys.length === 1) {
    const updated = await updateWebsocketConfigById(endpointId, payload.websocket_config);
    return { success: true, data: { ...endpoint, websocket_config: updated?.websocket_config ?? payload.websocket_config } };
  }

  // 🔍 Handle schema separately (stateful only)
  if (keys.includes("schema") && keys.length === 1) {
    if (!is_stateful) {
      return { success: false, message: "Stateless endpoints only allow updating the name." };
    }
    if (typeof payload.schema !== "object" || Array.isArray(payload.schema) || Object.keys(payload.schema).length === 0) {
      return { success: false, message: "Invalid schema format." };
    }
    const { rows: updatedRows } = await clientStateless.query(
      `UPDATE endpoints_ful
          SET schema = $1::jsonb,
              updated_at = NOW()
        WHERE endpoint_id = $2
      RETURNING *`,
      [JSON.stringify(payload.schema), endpointId]
    );
    return { success: true, data: updatedRows[0] };
  }

  // 🔍 Handle name + path updates (meta updates)
  const newName = payload.name;
  const newPath = payload.path;
  const hasNameUpdate = newName !== undefined;
  const hasPathUpdate = newPath !== undefined;

  // Get folder info for project_id
  const { rows: folderRows } = await clientStateless.query(
    `SELECT project_id FROM folders WHERE id = $1`,
    [folder_id]
  );
  if (folderRows.length === 0) {
    return { success: false, message: "Folder not found." };
  }
  const projectId = folderRows[0].project_id;

  // Validate name if updating
  if (hasNameUpdate) {
    const { rows: dupNameRows } = await clientStateless.query(
      `SELECT e.id
         FROM endpoints e
         JOIN folders f ON f.id = e.folder_id
        WHERE f.project_id = $1
          AND LOWER(e.name) = LOWER($2)
          AND e.id <> $3`,
      [projectId, newName, endpointId]
    );
    if (dupNameRows.length > 0) {
      return { success: false, message: "An endpoint with this name already exists in this project." };
    }
  }

  // Validate path if updating
  if (hasPathUpdate) {
    const { rows: dupPathRows } = await clientStateless.query(
      `SELECT e.id FROM endpoints e
         JOIN folders f ON f.id = e.folder_id
        WHERE f.project_id = $1
          AND e.path = $2
          AND e.method = $3
          AND e.id <> $4`,
      [projectId, newPath, endpoint.method, endpointId]
    );
    if (dupPathRows.length > 0) {
      return { success: false, message: "Path + Method combination already exists in this project." };
    }

    // Check stateful constraints when path changes
    const isCurrentlyStateful = endpoint.is_stateful === true;
    const oldPathHasParamOrQuery = hasQueryOrRouteParams(endpoint.path);
    const newPathHasParamOrQuery = hasQueryOrRouteParams(newPath);

    // Case 1: stateful endpoint + newPath có query/param → auto-revert to stateless trước
    if (isCurrentlyStateful && newPathHasParamOrQuery) {
      try {
        // Auto-revert to stateless first
        await clientStateless.query(
          `UPDATE endpoints SET is_stateful = FALSE, is_active = TRUE, path = $1, name = COALESCE($2, name), updated_at = NOW() WHERE id = $3`,
          [newPath, newName || null, endpointId]
        );
        // Deactivate stateful version
        const { rows: sfRows } = await clientStateless.query(
          `SELECT id FROM endpoints_ful WHERE endpoint_id = $1`,
          [endpointId]
        );
        if (sfRows.length > 0) {
          await clientStateless.query(
            `UPDATE endpoints_ful SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
            [sfRows[0].id]
          );
        }
        const updatedEp = { ...endpoint, path: newPath, is_stateful: false, is_active: true };
        if (newName) updatedEp.name = newName;
        return { 
          success: true, 
          data: updatedEp,
          message: "Endpoint automatically reverted to stateless and path updated (stateful endpoints cannot have query/route parameters)." 
        };
      } catch (err) {
        console.warn("⚠️ Warning auto-reverting to stateless:", err.message);
        return { 
          success: false, 
          message: "Failed to auto-revert endpoint to stateless. Please try again." 
        };
      }
    }

    // Case 2: hiện tại không query/param → mới có → tắt stateful thành stateless
    if (!oldPathHasParamOrQuery && newPathHasParamOrQuery && isCurrentlyStateful) {
      // Auto-revert to stateless
      await clientStateless.query(
        `UPDATE endpoints SET is_stateful = FALSE, is_active = TRUE, path = $1, name = COALESCE($2, name), updated_at = NOW() WHERE id = $3`,
        [newPath, newName || null, endpointId]
      );
      // Deactivate stateful version
      const { rows: sfRows } = await clientStateless.query(
        `SELECT id FROM endpoints_ful WHERE endpoint_id = $1`,
        [endpointId]
      );
      if (sfRows.length > 0) {
        await clientStateless.query(
          `UPDATE endpoints_ful SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
          [sfRows[0].id]
        );
      }
      const updatedEp = { ...endpoint, path: newPath, is_stateful: false, is_active: true };
      if (newName) updatedEp.name = newName;
      return { 
        success: true, 
        data: updatedEp,
        message: "Path updated and endpoint reverted to stateless (stateful endpoints cannot have query/route parameters)." 
      };
    }

    // Case 3: update path bình thường (cùng loại query/param structure)
    // Nếu stateful + path thay đổi từ không param → không param (tạo/đảm bảo Mongo collection)
    if (isCurrentlyStateful && !newPathHasParamOrQuery) {
      try {
        const endpointData = await clientStateless.query(
          `SELECT w.name AS workspace_name, p.name AS project_name
             FROM endpoints e
             JOIN folders f ON f.id = e.folder_id
             JOIN projects p ON p.id = f.project_id
             JOIN workspaces w ON w.id = p.workspace_id
            WHERE e.id = $1`,
          [endpointId]
        );
        const { workspace_name, project_name } = endpointData.rows[0] || { workspace_name: "Workspace", project_name: "Project" };
        
        // Import helper từ endpoints_ful.service
        const endpointsFulSvc = require("./endpoints_ful.service");
        // Ensure Mongo collection exists cho path mới (trống)
        await endpointsFulSvc.mongoUpsertEmptyIfMissing(newPath, workspace_name, project_name);
      } catch (err) {
        console.warn("⚠️ Warning updating Mongo collection for path:", err.message);
      }
    }
  }

  // Update both name and path in single query
  const updateFields = [];
  const updateValues = [];
  let paramIndex = 1;

  if (hasNameUpdate) {
    updateFields.push(`name = $${paramIndex++}`);
    updateValues.push(newName);
  }
  if (hasPathUpdate) {
    updateFields.push(`path = $${paramIndex++}`);
    updateValues.push(newPath);
  }

  updateFields.push(`updated_at = NOW()`);
  updateValues.push(endpointId);

  const updateQuery = `UPDATE endpoints SET ${updateFields.join(", ")} WHERE id = $${paramIndex} RETURNING *`;
  const { rows: updatedRows } = await clientStateless.query(updateQuery, updateValues);

  // 🔄 If path was updated and endpoint is stateful → regenerate response bodies
  if (hasPathUpdate && is_stateful) {
    try {
      const oldPathName = capitalizeFromPath(endpoint.path);
      const newPathName = capitalizeFromPath(newPath);

      // Only proceed if path names are different
      if (oldPathName !== newPathName) {
        // Get all stateful responses for this endpoint
        const { rows: responses } = await clientStateless.query(
          `SELECT id, response_body FROM endpoint_responses_ful WHERE endpoint_id = $1`,
          [endpointId]
        );

        let updatedCount = 0;

        // Update each response body to replace old path name with new path name
        for (const resp of responses) {
          // response_body is already an object (JSONB from PG)
          let updatedBody = resp.response_body;
          
          // Ensure it's an object
          if (typeof updatedBody === "string") {
            updatedBody = JSON.parse(updatedBody);
          }
          
          // Deep clone to avoid mutation issues
          updatedBody = JSON.parse(JSON.stringify(updatedBody));

          // Helper function to recursively replace old path name with new in all string values
          const replaceInObject = (obj) => {
            let changed = false;
            if (obj && typeof obj === "object") {
              for (const key in obj) {
                if (typeof obj[key] === "string") {
                  // Replace all occurrences of old path name with new path name
                  if (obj[key].includes(oldPathName)) {
                    obj[key] = obj[key].replaceAll(oldPathName, newPathName);
                    changed = true;
                  }
                } else if (typeof obj[key] === "object" && obj[key] !== null) {
                  if (replaceInObject(obj[key])) {
                    changed = true;
                  }
                }
              }
            }
            return changed;
          };
          
          // Always attempt replacement - it will only change if old path name exists
          const wasChanged = replaceInObject(updatedBody);
          
          if (wasChanged) {
            // Update the response with proper JSONB stringify
            await clientStateless.query(
              `UPDATE endpoint_responses_ful SET response_body = $1::jsonb, updated_at = NOW() WHERE id = $2`,
              [JSON.stringify(updatedBody), resp.id]
            );
            updatedCount++;
          }
        }
        console.log(`✅ Updated ${updatedCount} stateful response bodies from "${oldPathName}" to "${newPathName}"`);
      }
    } catch (err) {
      console.warn("⚠️ Warning updating stateful response bodies:", err.message);
    }
  }

  return { success: true, data: updatedRows[0] };
}

// Delete endpoint
async function deleteEndpoint(dbPool, endpointId) {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    // (A) Nullify logs trước để tránh FK (nếu có)
    //   - cả stateless lẫn stateful (khi đã convert)
    await client.query(
      `
      UPDATE project_request_logs
         SET endpoint_id = NULL,
             stateful_endpoint_id = NULL,
             stateful_endpoint_response_id = NULL
       WHERE endpoint_id = $1
          OR stateful_endpoint_id IN (SELECT id FROM endpoints_ful WHERE endpoint_id = $1)
    `,
      [endpointId]
    );

    // (B) Xoá responses STATEFUL trước (nếu có)
    await client.query(
      `
     DELETE FROM endpoint_responses_ful
       WHERE endpoint_id IN (SELECT id FROM endpoints_ful WHERE endpoint_id = $1)
    `,
      [endpointId]
    );

    // (C) Xoá bản ghi STATEFUL meta
    await client.query(`DELETE FROM endpoints_ful WHERE endpoint_id = $1`, [endpointId]);

    // (D) Xoá responses STATELESS
    await client.query(`DELETE FROM endpoint_responses WHERE endpoint_id = $1`, [endpointId]);

    // (E) (Tuỳ chọn) CHỈ chạy nếu còn bảng notifications
    const { rows } = await client.query(`SELECT to_regclass('public.notifications') IS NOT NULL AS exists`);
    if (rows?.[0]?.exists) {
      await client.query(
        `
        UPDATE notifications
           SET project_request_log_id = NULL,
               endpoint_id = NULL,
               user_id = NULL
         WHERE endpoint_id = $1
      `,
        [endpointId]
      );
    }

    // (F) Cuối cùng xoá endpoint gốc
    await client.query(`DELETE FROM endpoints WHERE id = $1`, [endpointId]);

    await client.query("COMMIT");
    return { success: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
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
  getWebsocketConfigById,
  updateWebsocketConfigById,
};
