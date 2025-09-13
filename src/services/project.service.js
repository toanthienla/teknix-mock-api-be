// src/services/project.service.js
const db = require('../config/db');
const { getWorkspaceRole } = require('./workspace.service');
const roles = require('../constants/roles');

async function getProjectsByWorkspace(userId, workspaceId) {
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!role) throw new Error('Bạn không có quyền truy cập workspace này');

  const { rows } = await db.query(
    'SELECT * FROM projects WHERE workspace_id=$1 ORDER BY created_at DESC',
    [workspaceId]
  );
  return rows;
}

async function createProject(userId, workspaceId, { name, description }) {
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!role) throw new Error('Bạn không có quyền tạo project trong workspace này');

  // check trùng tên trong workspace
  const dup = await db.query(
    'SELECT 1 FROM projects WHERE workspace_id=$1 AND name=$2 LIMIT 1',
    [workspaceId, name]
  );
  if (dup.rows.length) throw new Error('Tên project đã tồn tại trong workspace này');

  const { rows } = await db.query(
    'INSERT INTO projects(workspace_id, name, description) VALUES($1,$2,$3) RETURNING *',
    [workspaceId, name, description]
  );
  return rows[0];
}

async function updateProject(userId, projectId, { name, description }) {
  const q = 'SELECT * FROM projects WHERE id=$1';
  const { rows } = await db.query(q, [projectId]);
  if (!rows.length) throw new Error('Project không tồn tại');
  const project = rows[0];

  const role = await getWorkspaceRole(userId, project.workspace_id);
  if (!role) throw new Error('Bạn không có quyền thao tác project này');
  if (role !== roles.OWNER && role !== roles.ADMIN)
    throw new Error('Bạn cần là owner hoặc admin để cập nhật project');

  if (name) {
    const dup = await db.query(
      'SELECT 1 FROM projects WHERE workspace_id=$1 AND name=$2 AND id<>$3 LIMIT 1',
      [project.workspace_id, name, projectId]
    );
    if (dup.rows.length) throw new Error('Tên project đã tồn tại trong workspace này');
  }

  const { rows: updated } = await db.query(
    'UPDATE projects SET name=COALESCE($1,name), description=COALESCE($2,description), updated_at=NOW() WHERE id=$3 RETURNING *',
    [name, description, projectId]
  );
  return updated[0];
}

async function deleteProject(userId, projectId) {
  const q = 'SELECT * FROM projects WHERE id=$1';
  const { rows } = await db.query(q, [projectId]);
  if (!rows.length) throw new Error('Project không tồn tại');
  const project = rows[0];

  const role = await getWorkspaceRole(userId, project.workspace_id);
  if (!role) throw new Error('Bạn không có quyền thao tác project này');
  if (role !== roles.OWNER) throw new Error('Chỉ owner mới được xóa project');

  await db.query('DELETE FROM projects WHERE id=$1', [projectId]);
  return true;
}

module.exports = {
  getProjectsByWorkspace,
  createProject,
  updateProject,
  deleteProject
};
