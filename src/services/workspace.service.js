//const db = require('../config/db');
const logSvc = require("./project_request_log.service");
const endpointsFulSvc = require("./endpoints_ful.service");
const { validateNameOrError } = require("../middlewares/validateNameOrError");
const { connectMongo } = require("../config/db"); // 👈 dùng để lấy MongoDB instance

// ====================================================================
// 🧩 Helper đổi tên workspace
// ====================================================================
async function renameWorkspaceCollections(oldWorkspaceName, newWorkspaceName) {
  const mongo = await connectMongo();
  const collections = await mongo.listCollections().toArray();

  const regex = new RegExp(`\\.${oldWorkspaceName}\\.[^.]+$`, "i");
  const renameTasks = [];

  for (const col of collections) {
    if (regex.test(col.name)) {
      const newName = col.name.replace(new RegExp(`\\.${oldWorkspaceName}\\.`), `.${newWorkspaceName}.`);
      console.log(`🔁 Đổi tên collection: ${col.name} → ${newName}`);
      renameTasks.push(mongo.renameCollection(col.name, newName));
    }
  }

  if (renameTasks.length === 0) {
    console.warn(`⚠️ Không tìm thấy collection nào thuộc workspace "${oldWorkspaceName}".`);
  }

  await Promise.all(renameTasks);
  return renameTasks.length;
}

// ====================================================================
// 🧩 Các hàm service chính
// ====================================================================

// Get all workspaces
async function getAllWorkspaces(db) {
  const { rows } = await db.query("SELECT * FROM workspaces ORDER BY created_at DESC");
  return { success: true, data: rows };
}

// Get workspace by id
async function getWorkspaceById(db, id) {
  const { rows } = await db.query("SELECT * FROM workspaces WHERE id=$1", [id]);
  const workspace = rows[0] || null;
  return { success: true, data: workspace };
}

// Create workspace (check duplicate name)
async function createWorkspace(db, { name }) {
  const invalid = validateNameOrError(name);
  if (invalid) return invalid;

  const { rows: existRows } = await db.query("SELECT id FROM workspaces WHERE LOWER(name)=LOWER($1)", [name]);
  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: "name", message: "Workspace already exists" }],
    };
  }

  const { rows } = await db.query("INSERT INTO workspaces(name) VALUES($1) RETURNING *", [name]);
  return { success: true, data: rows[0] };
}

// Update workspace (check duplicate name + rename Mongo)
async function updateWorkspace(db, id, { name }) {
  if (name != null) {
    const invalid = validateNameOrError(name);
    if (invalid) return invalid;
  }

  const { rows: currentRows } = await db.query("SELECT * FROM workspaces WHERE id=$1", [id]);
  if (currentRows.length === 0) {
    return { success: false, notFound: true };
  }

  const oldWorkspace = currentRows[0];
  const oldName = oldWorkspace.name;
  const newName = name ?? oldName;

  if (oldName === newName) {
    // Không đổi tên → bỏ qua rename
    return { success: true, data: oldWorkspace };
  }

  // Check duplicate name
  const { rows: existRows } = await db.query("SELECT id FROM workspaces WHERE LOWER(name)=LOWER($1) AND id<>$2", [newName, id]);
  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: "name", message: "Workspace already exists" }],
    };
  }

  // Cập nhật trong PostgreSQL
  const { rows } = await db.query("UPDATE workspaces SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING *", [newName, id]);

  // Cập nhật trong MongoDB (rename collection)
  try {
    await renameWorkspaceCollections(oldName, newName);
  } catch (err) {
    console.error(`⚠️ Không thể rename collection cho workspace ${oldName}:`, err.message);
  }

  return { success: true, data: rows[0] };
}

// Delete workspace
async function deleteWorkspace(db, id) {
  const { rows } = await db.query("DELETE FROM workspaces WHERE id=$1 RETURNING id", [id]);
  if (rows.length === 0) {
    return { success: false, notFound: true };
  }
  return { success: true, data: rows[0] };
}

// Delete workspace + handle logs
async function deleteWorkspaceAndHandleLogs(db, workspaceId) {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const { rows: workspaceRows } = await client.query("SELECT id FROM workspaces WHERE id = $1", [workspaceId]);
    if (workspaceRows.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, notFound: true };
    }

    const { rows: epRows } = await client.query(
      `SELECT e.id
         FROM endpoints e
         JOIN folders f ON f.id = e.folder_id
         JOIN projects p ON p.id = f.project_id
        WHERE p.workspace_id = $1`,
      [workspaceId]
    );
    const endpointIds = epRows.map((r) => r.id);

    await logSvc.nullifyWorkspaceTree(client, workspaceId);
    await client.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await client.query("COMMIT");

    if (endpointIds.length > 0) {
      await endpointsFulSvc.deleteByOriginIds(endpointIds);
    }

    return { success: true, data: { id: workspaceId }, affectedEndpoints: endpointIds.length };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`Transaction failed for deleting workspace ${workspaceId}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getAllWorkspaces,
  getWorkspaceById,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  deleteWorkspaceAndHandleLogs,
};
