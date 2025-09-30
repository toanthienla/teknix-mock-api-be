// src/services/folder.service.js
const db = require('../config/db');

// Get all folders by project_id
async function getFolders(project_id) {
  const { rows } = await db.query(
    `SELECT id, project_id, name, description, created_at, updated_at
     FROM folders
     WHERE project_id = $1
     ORDER BY id ASC`,
    [project_id]
  );
  return rows;
}

// Get folder by id
async function getFolderById(id) {
  const { rows } = await db.query(
    `SELECT id, project_id, name, description, created_at, updated_at
     FROM folders
     WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Create new folder
async function createFolder({ project_id, name, description }) {
  const { rows } = await db.query(
    `INSERT INTO folders (project_id, name, description)
     VALUES ($1, $2, $3)
     RETURNING id, project_id, name, description, created_at, updated_at`,
    [project_id, name, description]
  );
  return rows[0];
}

// Update folder
async function updateFolder(id, { name, description }) {
  const { rows } = await db.query(
    `UPDATE folders
     SET name = COALESCE($2, name),
         description = COALESCE($3, description),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, project_id, name, description, created_at, updated_at`,
    [id, name, description]
  );
  return rows[0] || null;
}

// Delete folder
async function deleteFolder(id) {
  const { rowCount } = await db.query(
    `DELETE FROM folders WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}

module.exports = {
  getFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolder,
};
