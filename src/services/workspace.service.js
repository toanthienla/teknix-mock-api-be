const db = require('../config/db');

async function getAllWorkspaces() {
  const { rows } = await db.query('SELECT * FROM workspaces ORDER BY created_at DESC');
  return rows;
}

async function getWorkspaceById(id) {
  const { rows } = await db.query('SELECT * FROM workspaces WHERE id=$1', [id]);
  return rows[0];
}

async function createWorkspace({ name }) {
  const { rows } = await db.query(
    'INSERT INTO workspaces(name) VALUES($1) RETURNING *',
    [name]
  );
  return rows[0];
}

async function updateWorkspace(id, { name }) {
  const { rows } = await db.query(
    'UPDATE workspaces SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [name, id]
  );
  return rows[0];
}

async function deleteWorkspace(id) {
  await db.query('DELETE FROM workspaces WHERE id=$1', [id]);
  return true;
}

module.exports = { getAllWorkspaces, getWorkspaceById, createWorkspace, updateWorkspace, deleteWorkspace };
