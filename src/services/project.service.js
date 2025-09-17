const db = require('../config/db');

// Get all projects (optionally filter by workspace_id)
async function getProjects(workspace_id) {
  let query = 'SELECT * FROM projects';
  const params = [];

  if (workspace_id) {
    query += ' WHERE workspace_id=$1';
    params.push(workspace_id);
  }

  query += ' ORDER BY created_at DESC';

  const { rows } = await db.query(query, params);
  return rows; // array object trần
}

// Get project by id
async function getProjectById(projectId) {
  const { rows } = await db.query(
    'SELECT * FROM projects WHERE id=$1',
    [projectId]
  );
  return rows[0] || null; // object trần hoặc null
}

// Create project (check duplicate in same workspace)
async function createProject({ workspace_id, name, description }) {
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
    'INSERT INTO projects(workspace_id, name, description) VALUES($1,$2,$3) RETURNING *',
    [workspace_id, name, description]
  );
  return rows[0]; // object trần
}

// Update project (check duplicate in same workspace, ignore itself)
async function updateProject(projectId, { name, description }) {
  if (name) {
    const { rows: existRows } = await db.query(
      'SELECT id, workspace_id FROM projects WHERE LOWER(name)=LOWER($1) AND id<>$2',
      [name, projectId]
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
    [name, description, projectId]
  );
  return rows[0] || null; // object trần hoặc null
}

// Delete project
async function deleteProject(projectId) {
  const { rows } = await db.query(
    'DELETE FROM projects WHERE id=$1 RETURNING id',
    [projectId]
  );
  return rows[0] || null; // { id: ... } hoặc null nếu project không tồn tại
}

module.exports = { 
  getProjects, 
  getProjectById, 
  createProject, 
  updateProject, 
  deleteProject 
};
