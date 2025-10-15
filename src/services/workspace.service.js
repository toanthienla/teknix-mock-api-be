//const db = require('../config/db');
const logSvc = require('./project_request_log.service');
const endpointsFulSvc = require('./endpoints_ful.service');

// Chỉ cho phép: A-Z a-z 0-9 và dấu gạch dưới (_)
const NAME_RE = /^[A-Za-z0-9_]+$/;
function validateNameOrError(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return {
      success: false,
      errors: [{
        field: "name",
        message: "Tên chỉ được chứa chữ cái tiếng Anh, số và dấu gạch dưới (_). Không được có dấu cách, dấu hoặc ký tự đặc biệt."
      }]
    };
  }
  return null;
}
// Get all workspaces
async function getAllWorkspaces(db) {
  const { rows } = await db.query(
    "SELECT * FROM workspaces ORDER BY created_at DESC"
  );
  // Luôn trả về cấu trúc nhất quán
  return { success: true, data: rows };
}

// Get workspace by id
async function getWorkspaceById(db, id) {
  const { rows } = await db.query("SELECT * FROM workspaces WHERE id=$1", [id]);
  const workspace = rows[0] || null;
  // Nếu không có dữ liệu, success vẫn là true nhưng data là null
  return { success: true, data: workspace };
}

// Create workspace (check duplicate name)
async function createWorkspace(db, { name }) {
  // Validate format tên
  const invalid = validateNameOrError(name);
  if (invalid) return invalid;
  const { rows: existRows } = await db.query(
    "SELECT id FROM workspaces WHERE LOWER(name)=LOWER($1)",
    [name]
  );

  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: "name", message: "Workspace already exists" }],
    };
  }

  const { rows } = await db.query(
    "INSERT INTO workspaces(name) VALUES($1) RETURNING *",
    [name]
  );
  return { success: true, data: rows[0] };
}

// Update workspace (check duplicate name)
async function updateWorkspace(db, id, { name }) {
  // Validate nếu client gửi name
  if (name != null) {
    const invalid = validateNameOrError(name);
   if (invalid) return invalid;
  }
  // Lấy workspace hiện tại để kiểm tra tồn tại
  const { rows: currentRows } = await db.query('SELECT * FROM workspaces WHERE id=$1', [id]);
  if (currentRows.length === 0) {
    return { success: false, notFound: true }; // Thêm cờ notFound để controller biết trả 404
  }

  // Kiểm tra tên trùng lặp
  const { rows: existRows } = await db.query(
    'SELECT id FROM workspaces WHERE LOWER(name)=LOWER($1) AND id<>$2',
    [name, id]
  );

  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: 'name', message: 'Workspace already exists' }]
    };
  }

  const { rows } = await db.query(
    'UPDATE workspaces SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [name, id]
  );

  return { success: true, data: rows[0] };
}


// Delete workspace
async function deleteWorkspace(db, id) {
  const { rows } = await db.query(
    "DELETE FROM workspaces WHERE id=$1 RETURNING id",
    [id]
  );
  if (rows.length === 0) {
     return { success: false, notFound: true };
  }
  return { success: true, data: rows[0] };
}

// Xử lý nghiệp vụ xóa và log trong transaction
async function deleteWorkspaceAndHandleLogs(db, workspaceId) {
  const client = await db.connect(); // Lấy client từ pool để dùng transaction

  try {
    await client.query('BEGIN');

    // Bước 1: Kiểm tra workspace có tồn tại không
    const { rows: workspaceRows } = await client.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
    if (workspaceRows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, notFound: true };
    }

    // Bước 2: NULL hóa các tham chiếu trong bảng log
    // Giả định hàm này đã được cập nhật để nhận client
    // Gather stateless endpoint IDs in this workspace BEFORE delete (for stateful cleanup)
    const { rows: epRows } = await client.query(
      `SELECT e.id
         FROM endpoints e
         JOIN folders f ON f.id = e.folder_id
         JOIN projects p ON p.id = f.project_id
        WHERE p.workspace_id = $1`,
      [workspaceId]
    );
    const endpointIds = epRows.map(r => r.id);

    // Nullify logs first
    await logSvc.nullifyWorkspaceTree(client, workspaceId);

    // Bước 3: Xóa workspace
    await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);

    await client.query('COMMIT'); // Hoàn tất transaction
    // Cleanup STATEFUL side (PG + Mongo) outside stateless tx
    if (endpointIds.length > 0) {
      await endpointsFulSvc.deleteByOriginIds(endpointIds);
    }
    return { success: true, data: { id: workspaceId }, affectedEndpoints: endpointIds.length };
  } catch (err) {
    await client.query('ROLLBACK'); // Hoàn tác nếu có lỗi
    console.error(`Transaction failed for deleting workspace ${workspaceId}:`, err);
    throw err; // Ném lỗi để controller bắt và trả về 500
  } finally {
    client.release(); // Luôn trả client về pool
  }
}

module.exports = {
  getAllWorkspaces,
  getWorkspaceById,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  deleteWorkspaceAndHandleLogs, // Thêm hàm mới vào export
};