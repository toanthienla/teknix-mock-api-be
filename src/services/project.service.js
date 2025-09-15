const db = require('../config/db');

async function getProjectsByWorkspace(workspaceId) {
  const { rows } = await db.query(
    'SELECT * FROM projects WHERE workspace_id=$1 ORDER BY created_at DESC',
    [workspaceId]
  );
  return rows;
}

async function getProjectById(workspaceId, projectId) {
  const { rows } = await db.query(
    'SELECT * FROM projects WHERE workspace_id=$1 AND id=$2',
    [workspaceId, projectId]
  );
  return rows[0];
}

async function createProject(workspaceId, { name, description }) {
  const { rows } = await db.query(
    'INSERT INTO projects(workspace_id, name, description) VALUES($1,$2,$3) RETURNING *',
    [workspaceId, name, description]
  );
  return rows[0];
}

async function updateProject(workspaceId, projectId, { name, description }) {
  const { rows } = await db.query(
    'UPDATE projects SET name=COALESCE($1,name), description=COALESCE($2,description), updated_at=NOW() WHERE id=$3 AND workspace_id=$4 RETURNING *',
    [name, description, projectId, workspaceId]
  );
  return rows[0];
}


async function deleteProject(workspaceId, projectId) {
  await db.query('DELETE FROM projects WHERE workspace_id=$1 AND id=$2', [workspaceId, projectId]);
  return true;
}

module.exports = { getProjectsByWorkspace, getProjectById, createProject, updateProject, deleteProject };
