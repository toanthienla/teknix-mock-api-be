// src/services/workspace.service.js
const db = require('../config/db');
const roles = require('../constants/roles');

async function getWorkspacesByUser(userId) {
  const q = `
    SELECT w.* 
    FROM workspaces w
    JOIN workspace_members m ON m.workspace_id = w.id
    WHERE m.user_id = $1
    ORDER BY w.created_at DESC
  `;
  const { rows } = await db.query(q, [userId]);
  return rows;
}

async function createWorkspace(userId, { name, description }) {
  // check unique per user
  const check = await db.query(
    'SELECT 1 FROM workspaces WHERE created_by=$1 AND name=$2 LIMIT 1',
    [userId, name]
  );
  if (check.rows.length) throw new Error('Tên workspace đã tồn tại');

  const { rows } = await db.query(
    'INSERT INTO workspaces(name, description, created_by) VALUES($1,$2,$3) RETURNING *',
    [name, description, userId]
  );
  const workspace = rows[0];

  // add member as owner
try {
  await db.query(
    'INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1,$2,$3)',
    [workspace.id, userId, roles.OWNER]
  );
  console.log(`✔ Member owner added for workspace ${workspace.id}`);
} catch (err) {
  console.error('❌ Error inserting workspace member:', err.message);
}


  return workspace;
}

async function getWorkspaceRole(userId, workspaceId) {
  const { rows } = await db.query(
    'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 LIMIT 1',
    [workspaceId, userId]
  );
  return rows[0] ? rows[0].role : null;
}

async function updateWorkspace(userId, workspaceId, { name, description }) {
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!role) throw new Error('Bạn không có quyền thao tác trên workspace này');
  if (role !== roles.OWNER && role !== roles.ADMIN)
    throw new Error('Bạn cần là owner hoặc admin để cập nhật workspace');

  if (name) {
    const dup = await db.query(
      'SELECT 1 FROM workspaces WHERE created_by=$1 AND name=$2 AND id<>$3 LIMIT 1',
      [userId, name, workspaceId]
    );
    if (dup.rows.length) throw new Error('Tên workspace đã tồn tại');
  }

  const { rows } = await db.query(
    'UPDATE workspaces SET name=COALESCE($1,name), description=COALESCE($2,description), updated_at=NOW() WHERE id=$3 RETURNING *',
    [name, description, workspaceId]
  );
  return rows[0];
}

async function deleteWorkspace(userId, workspaceId) {
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!role) throw new Error('Bạn không có quyền thao tác trên workspace này');
  if (role !== roles.OWNER) throw new Error('Chỉ owner mới được xóa workspace');
  await db.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
  return true;
}

module.exports = {
  getWorkspacesByUser,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getWorkspaceRole
};
