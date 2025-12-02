const logSvc = require("./project_request_log.service");
const endpointsFulSvc = require("./endpoints_ful.service");
const { validateNameOrError } = require("../middlewares/validateNameOrError");
const { connectMongo } = require("../config/db");

// ====================================================================
// 🧩 Helper: Rename các collection Mongo khi đổi tên Project
// ====================================================================
async function renameRelatedCollections(oldProjectName, newProjectName, workspaceName) {
  if (!oldProjectName || !newProjectName || !workspaceName) {
    console.warn("⚠️ renameRelatedCollections: Thiếu tham số bắt buộc");
    return 0;
  }

  const mongo = await connectMongo();
  const collections = await mongo.listCollections().toArray();

  // Regex match dạng: prefix.workspace.project
  // VD: teknix.workspaceA.projectA
  const regex = new RegExp(`\\.${workspaceName}\\.${oldProjectName}$`, "i");
  const renameTasks = [];

  for (const col of collections) {
    if (regex.test(col.name)) {
      const newName = col.name.replace(new RegExp(`\\.${workspaceName}\\.${oldProjectName}$`, "i"), `.${workspaceName}.${newProjectName}`);

      console.log(`🔁 Đổi tên collection: ${col.name} → ${newName}`);
      renameTasks.push(mongo.renameCollection(col.name, newName));
    }
  }

  if (renameTasks.length === 0) {
    console.warn(`⚠️ Không tìm thấy collection nào thuộc project "${oldProjectName}" trong workspace "${workspaceName}".`);
  }

  await Promise.all(renameTasks);
  return renameTasks.length;
}

// ====================================================================
// 🧱 CRUD chính cho Project
// ====================================================================

// 🟢 Get all projects
async function getProjects(db, workspace_id) {
  let query = "SELECT * FROM projects";
  const params = [];
  if (workspace_id) {
    query += " WHERE workspace_id=$1";
    params.push(workspace_id);
  }
  query += " ORDER BY created_at DESC";
  const { rows } = await db.query(query, params);
  return { success: true, data: rows };
}

// 🟢 Get project by ID
async function getProjectById(db, projectId) {
  const { rows } = await db.query("SELECT * FROM projects WHERE id=$1", [projectId]);
  return { success: true, data: rows[0] || null };
}

// Lấy tất cả endpoints của một project
async function getProjectEndpoints(db, projectId) {
  // 1️⃣ Check project có tồn tại không
  const { rows: projectRows } = await db.query("SELECT id FROM projects WHERE id = $1", [projectId]);
  if (projectRows.length === 0) {
    return { success: false, notFound: true };
  }

  // 2️⃣ Lấy danh sách endpoints thuộc project đó
  const { rows } = await db.query(
    `SELECT 
        e.*,
        f.name AS folder_name,
        f.project_id
     FROM endpoints e
     JOIN folders f ON f.id = e.folder_id
    WHERE f.project_id = $1
    ORDER BY e.id`,
    [projectId]
  );

  return { success: true, data: rows };
}

// 🟢 Create new project
async function createProject(db, { workspace_id, name, description }) {
  const invalid = validateNameOrError(name);
  if (invalid) return invalid;

  const { rows: existRows } = await db.query("SELECT id FROM projects WHERE workspace_id=$1 AND LOWER(name)=LOWER($2)", [workspace_id, name]);

  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: "name", message: "Project already exists in this workspace" }],
    };
  }

  const { rows } = await db.query("INSERT INTO projects (workspace_id, name, description) VALUES ($1,$2,$3) RETURNING *", [workspace_id, name, description ?? null]);

  return { success: true, data: rows[0] };
}

// 🟡 Update project
async function updateProject(db, projectId, { name, description }) {
  // 1️⃣ Validate tên mới (nếu có)
  if (name != null) {
    const invalid = validateNameOrError(name);
    if (invalid) return invalid;
  }

  // 2️⃣ Lấy project hiện tại + workspace
  const { rows: currentRows } = await db.query(
    `SELECT p.*, w.name AS workspace_name
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.id=$1`,
    [projectId]
  );

  if (currentRows.length === 0) return { success: false, notFound: true };
  const current = currentRows[0];

  // 3️⃣ Kiểm tra trùng tên trong workspace
  if (name) {
    const { rows: existRows } = await db.query("SELECT id FROM projects WHERE workspace_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3", [current.workspace_id, name, projectId]);
    if (existRows.length > 0) {
      return {
        success: false,
        errors: [{ field: "name", message: "Project already exists in this workspace" }],
      };
    }
  }

  // 4️⃣ Cập nhật PostgreSQL
  const { rows } = await db.query(
    `UPDATE projects 
       SET name=COALESCE($1,name),
           description=COALESCE($2,description),
           updated_at=NOW()
     WHERE id=$3
     RETURNING *`,
    [name ?? null, description ?? null, projectId]
  );

  const updated = rows[0];

  // 5️⃣ Nếu đổi tên → rename Mongo collections
  if (name && name !== current.name) {
    try {
      const count = await renameRelatedCollections(current.name, name, current.workspace_name);
      console.log(`✅ Đã rename ${count} collection Mongo liên quan tới project "${current.name}".`);
    } catch (err) {
      console.error("⚠️ Lỗi khi rename collection Mongo:", err);
    }
  }

  return { success: true, data: updated };
}

// 🟢 Update only websocket_enabled flag
async function updateProjectWebsocketEnabled(db, projectId, enabled) {
  const { rows } = await db.query(
    `UPDATE projects
        SET websocket_enabled = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, websocket_enabled, updated_at`,
    [projectId, Boolean(enabled)]
  );
  if (rows.length === 0) return { success: false, notFound: true };
  return { success: true, data: rows[0] };
}

// 🔴 Delete project (và log liên quan)
async function deleteProjectAndHandleLogs(db, projectId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: projectRows } = await client.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (projectRows.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, notFound: true };
    }

    // Lấy danh sách endpoints thuộc project
    const { rows: epRows } = await client.query(
      `SELECT e.id
         FROM endpoints e
         JOIN folders f ON f.id = e.folder_id
        WHERE f.project_id = $1`,
      [projectId]
    );

    const endpointIds = epRows.map((r) => r.id);

    // Xóa log + project
    await logSvc.nullifyProjectTree(client, projectId);
    await client.query("DELETE FROM projects WHERE id = $1", [projectId]);
    await client.query("COMMIT");

    // Xóa dữ liệu Mongo liên quan
    if (endpointIds.length > 0) {
      await endpointsFulSvc.deleteByOriginIds(endpointIds);
    }

    return { success: true, data: { id: projectId }, affectedEndpoints: endpointIds.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProjectAndHandleLogs,
  updateProjectWebsocketEnabled,
  getProjectEndpoints,
};
