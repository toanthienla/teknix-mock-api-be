//const db = require('../config/db');
const logSvc = require('./project_request_log.service');

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
// Get all projects (optionally filter by workspace_id)
async function getProjects(db, workspace_id) {
  let query = 'SELECT * FROM projects';
  const params = [];

  if (workspace_id) {
    query += ' WHERE workspace_id=$1';
    params.push(workspace_id);
  }

  query += ' ORDER BY created_at DESC';

  const { rows } = await db.query(query, params);
  return { success: true, data: rows };
}

// Get project by id
async function getProjectById(db, projectId) {
  const { rows } = await db.query(
    'SELECT * FROM projects WHERE id=$1',
    [projectId]
  );
  return { success: true, data: rows[0] || null };
}

// Create project (check duplicate in same workspace)
async function createProject(db, { workspace_id, name, description }) {
  // Validate format tên
  const invalid = validateNameOrError(name);
  if (invalid) return invalid;
  const { rows: existRows } = await db.query(
    'SELECT id FROM projects WHERE workspace_id=$1 AND LOWER(name)=LOWER($2)',
    [workspace_id, name]
  );

  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: 'name', message: 'Project already exists in the workspace' }]
    };
  }

  const { rows } = await db.query(
    'INSERT INTO projects (workspace_id, name, description) VALUES($1,$2,$3) RETURNING *',
    [workspace_id, name, description ?? null]
  );
     return { success: true, data: rows[0] };
 }

// Update project (check duplicate in same workspace, ignore itself)
async function updateProject(db, projectId, { name, description }) {
  // Validate nếu client gửi name
  if (name != null) {
    const invalid = validateNameOrError(name);
    if (invalid) return invalid;
  }
  const { rows: currentRows } = await db.query('SELECT * FROM projects WHERE id=$1', [projectId]);
  if (currentRows.length === 0) {
    return { success: false, notFound: true };
  }

  if (name) {
    // lấy workspace_id từ record hiện có để kiểm tra trùng trong cùng workspace
    const workspaceId = currentRows[0].workspace_id;
    const { rows: existRows } = await db.query(
      'SELECT id FROM projects WHERE workspace_id=$1 AND LOWER(name)=LOWER($2) AND id <> $3',
      [workspaceId, name, projectId]
    );
    if (existRows.length > 0) {
      return {
        success: false,
        errors: [{ field: 'name', message: 'Project already exists in the workspace' }]
      };
    }
  }

  const { rows } = await db.query(
    `UPDATE projects 
     SET name=COALESCE($1,name), 
         description=COALESCE($2,description), 
         updated_at=NOW() 
     WHERE id=$3 
     RETURNING *`,
    [name ?? null, description ?? null, projectId]
  );
  return { success: true, data: rows[0] };
}

// Delete project
async function deleteProjectAndHandleLogs(db, projectId) {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const { rows: projectRows } = await client.query('SELECT id FROM projects WHERE id = $1', [projectId]);
    if (projectRows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, notFound: true };
    }

    await logSvc.nullifyProjectTree(client, projectId);

    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);

    await client.query('COMMIT');
    return { success: true, data: { id: projectId } };
  } catch (err) {
    await client.query('ROLLBACK');
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
  deleteProjectAndHandleLogs 
};
