const db = require('../config/db');

// Get all workspaces
async function getAllWorkspaces() {
  const { rows } = await db.query(
    'SELECT * FROM workspaces ORDER BY created_at DESC'
  );
  return rows;
}

// Get workspace by id
async function getWorkspaceById(id) {
  const { rows } = await db.query('SELECT * FROM workspaces WHERE id=$1', [id]);
  return rows[0];
}

// Create workspace (check duplicate name)
async function createWorkspace({ name }) {
  // Check duplicate
  const { rows: existRows } = await db.query(
    'SELECT id FROM workspaces WHERE LOWER(name)=LOWER($1)',
    [name]
  );

  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: 'name', message: 'Workspace already exists' }]
    };
  }

  const { rows } = await db.query(
    'INSERT INTO workspaces(name) VALUES($1) RETURNING *',
    [name]
  );
  return rows[0];
}

// Update workspace (check duplicate name)
async function updateWorkspace(id, { name }) {
  // Check duplicate with other workspaces
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
  return rows[0];
}

// Delete workspace
async function deleteWorkspace(id) {
  await db.query('DELETE FROM workspaces WHERE id=$1', [id]);
  return true;
}

module.exports = {
  getAllWorkspaces,
  getWorkspaceById,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace
};
