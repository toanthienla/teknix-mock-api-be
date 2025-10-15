const logSvc = require("./project_request_log.service");
const { getCollection2 } = require("../config/db");
const endpointsFulSvc = require("./endpoints_ful.service");

// Chỉ cho phép: A-Z a-z 0-9 và dấu gạch dưới (_)
const NAME_RE = /^[A-Za-z0-9_]+$/;
function validateNameOrError(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return {
      success: false,
      errors: [
        {
          field: "name",
          message: "Tên chỉ được chứa chữ cái tiếng Anh, số và dấu gạch dưới (_). Không được có dấu cách, dấu hoặc ký tự đặc biệt.",
        },
      ],
    };
  }
  return null;
}
// Get all folders (optionally filter by project_id)
async function getFolders(db, project_id) {
  let query = `
    SELECT id, project_id, name, description, created_at, updated_at
    FROM folders
  `;
  const params = [];

  // Nếu có project_id, thêm điều kiện WHERE để lọc
  if (project_id) {
    query += " WHERE project_id = $1";
    params.push(project_id);
  }

  query += " ORDER BY id ASC";

  const { rows } = await db.query(query, params);
  return { success: true, data: rows };
}

// Get folder by id
async function getFolderById(db, id) {
  const { rows } = await db.query(
    `SELECT id, project_id, name, base_schema, description, created_at, updated_at, is_public
     FROM folders
     WHERE id = $1`,
    [id]
  );
  return { success: true, data: rows[0] || null };
}

async function createFolder(db, { project_id, name, description, is_public }) {
  // Validate format tên
  const invalid = validateNameOrError(name);
  if (invalid) return invalid;

  // Kiểm tra trùng tên trong cùng project (không còn theo user)
  const { rows: existRows } = await db.query(
    `SELECT id 
     FROM folders 
     WHERE project_id = $1 AND LOWER(name) = LOWER($2)`,
    [project_id, name]
  );

  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: "name", message: "Folder name already exists in this project" }],
    };
  }

  const { rows } = await db.query(
    `INSERT INTO folders (project_id, name, description, is_public)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, name, description, is_public, created_at, updated_at`,
    [project_id, name, description, is_public]
  );

  return { success: true, data: rows[0] };
}

async function updateFolder(dbStateless, dbStateful, id, payload) {
  const { name, description, is_public, base_schema } = payload;

  // Validate nếu client gửi name
  if (name != null) {
    const invalid = validateNameOrError(name);
    if (invalid) return invalid;
  }

  // 🧱 1️⃣ Kiểm tra folder có tồn tại không
  const { rows: currentRows } = await dbStateless.query("SELECT * FROM folders WHERE id = $1", [id]);
  if (currentRows.length === 0) {
    return { success: false, notFound: true };
  }

  const folder = currentRows[0];

  // 🚦 2️⃣ Nếu người dùng gửi base_schema → xử lý riêng
  if (base_schema) {
    if (!dbStateful) {
      return { success: false, message: "Stateful DB connection required" };
    }

    if (typeof base_schema !== "object" || Array.isArray(base_schema)) {
      return { success: false, message: "Invalid base_schema format" };
    }

    // ✅ Cập nhật base_schema trước
    const { rows } = await dbStateless.query(
      `UPDATE folders
       SET base_schema = $1::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, project_id, name, description, is_public, base_schema, created_at, updated_at`,
      [JSON.stringify(base_schema), id]
    );

    const updatedFolder = rows[0];

    // 🔍 3️⃣ Sau khi update, kiểm tra xem có endpoint nào đã được chuyển stateful chưa
    const { rows: endpoints } = await dbStateless.query("SELECT id, path FROM endpoints WHERE folder_id = $1", [id]);

    if (endpoints.length > 0) {
      const endpointIds = endpoints.map((e) => e.id);
      const { rows: used } = await dbStateful.query("SELECT id, origin_id FROM endpoints_ful WHERE origin_id = ANY($1)", [endpointIds]);

      // ⚙️ Nếu có endpoint stateful → gọi reset Mongo collections
      if (used.length > 0) {
        try {
          await resetMongoCollectionsByFolder(id, dbStateless);
        } catch (err) {
          console.error("Error resetting Mongo collections:", err);
        }
      }
    }

    return { success: true, data: updatedFolder };
  }

  // 🧱 4️⃣ Nếu không có base_schema → giữ nguyên logic cũ
  if (name) {
    const { rows: existRows } = await dbStateless.query("SELECT id FROM folders WHERE project_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3", [folder.project_id, name, id]);
    if (existRows.length > 0) {
      return {
        success: false,
        errors: [{ field: "name", message: "Folder name already exists in this project" }],
      };
    }
  }

  const { rows } = await dbStateless.query(
    `UPDATE folders
     SET name = COALESCE($1, name),
         description = COALESCE($2, description),
         is_public = COALESCE($3, is_public),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING id, project_id, user_id, name, description, is_public, base_schema, created_at, updated_at`,
    [name, description, is_public, id]
  );

  return { success: true, data: rows[0] };
}

/**
 * Reset lại data_default và data_current trong MongoDB
 * cho toàn bộ collection thuộc folder chỉ định.
 */
async function resetMongoCollectionsByFolder(folderId, dbStateless) {
  // Lấy danh sách endpoint trong folder
  const endpoints = await dbStateless.query(
    `SELECT 
       e.path, 
       w.name AS workspace_name, 
       p.name AS project_name, 
       f.base_schema
     FROM endpoints e
     JOIN folders f ON e.folder_id = f.id
     JOIN projects p ON f.project_id = p.id
     JOIN workspaces w ON p.workspace_id = w.id
     WHERE e.folder_id = $1`,
    [folderId]
  );

  if (endpoints.rows.length === 0) {
    console.log("⚠️ Folder không chứa endpoint nào, bỏ qua reset Mongo.");
    return;
  }

  for (const ep of endpoints.rows) {
    const collection = getCollection2(ep.path, ep.workspace_name, ep.project_name);

    let fields = [];
    try {
      const schema = typeof ep.base_schema === "string" ? JSON.parse(ep.base_schema) : ep.base_schema;

      if (schema && typeof schema === "object") {
        // chấp nhận cả dạng có "properties" hoặc không
        const base = schema.properties || schema;
        fields = Object.keys(base);
      }
    } catch (err) {
      console.warn(`⚠️ Base schema không hợp lệ cho endpoint ${ep.path}:`, err.message);
      continue;
    }

    // Tạo document mẫu: tất cả field = null, id = 1
    const baseDoc = { id: 1 };
    for (const f of fields) {
      if (f !== "id") baseDoc[f] = null;
    }

    // Ghi vào Mongo (upsert)
    await collection.updateOne({}, { $set: { data_default: [baseDoc], data_current: [baseDoc] } }, { upsert: true });

    console.log(`✅ Reset collection "${ep.path}.${ep.workspace_name}.${ep.project_name}" thành công`);
  }
}

// Delete folder and handle related logs inside a transaction
async function deleteFolderAndHandleLogs(db, folderId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: folderRows } = await client.query("SELECT id FROM folders WHERE id = $1", [folderId]);
    if (folderRows.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, notFound: true };
    }

    // Gather stateless endpoint IDs in this folder BEFORE delete (for stateful cleanup)
    const { rows: epRows } = await client.query(`SELECT e.id FROM endpoints e WHERE e.folder_id = $1`, [folderId]);
    const endpointIds = epRows.map((r) => r.id);

    // Nullify logs for this folder (param order: client first)
    await logSvc.nullifyFolderTree(client, folderId);

    await client.query("DELETE FROM folders WHERE id = $1", [folderId]);

    await client.query("COMMIT");
    // Cleanup STATEFUL side (PG + Mongo) outside stateless tx
    if (endpointIds.length > 0) {
      await endpointsFulSvc.deleteByOriginIds(endpointIds);
    }
    return { success: true, data: { id: folderId }, affectedEndpoints: endpointIds.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolderAndHandleLogs,
};
