// src/services/folder.service.js
const logSvc = require('./project_request_log.service'); // Giả định service log tồn tại

// Get all folders by project_id
async function getFolders(db, project_id) {
  const { rows } = await db.query(
    `SELECT id, project_id, name, description, created_at, updated_at
     FROM folders
     WHERE project_id = $1
     ORDER BY id ASC`,
    [project_id]
  );
  return { success: true, data: rows };
}

// Get folder by id
async function getFolderById(db, id) {
  const { rows } = await db.query(
    `SELECT id, project_id, name, description, created_at, updated_at
     FROM folders
     WHERE id = $1`,
    [id]
  );
  return { success: true, data: rows[0] || null };
}

// Create new folder
async function createFolder(db, { project_id, name, description }) {
  // Thêm logic kiểm tra tên trùng lặp trong cùng project
  const { rows: existRows } = await db.query(
    'SELECT id FROM folders WHERE project_id=$1 AND LOWER(name)=LOWER($2)',
    [project_id, name]
  );

  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: 'name', message: 'Folder name already exists in this project' }]
    };
  }

  const { rows } = await db.query(
    `INSERT INTO folders (project_id, name, description)
     VALUES ($1, $2, $3)
     RETURNING id, project_id, name, description, created_at, updated_at`,
    [project_id, name, description]
  );
  return { success: true, data: rows[0] };
}

// Update folder
async function updateFolder(db, id, { name, description }) {
  const { rows: currentRows } = await db.query('SELECT * FROM folders WHERE id=$1', [id]);
  if (currentRows.length === 0) {
    return { success: false, notFound: true };
  }

  if (name) {
    const { rows: existRows } = await db.query(
      'SELECT id FROM folders WHERE project_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3',
      [currentRows[0].project_id, name, id]
    );
    if (existRows.length > 0) {
      return {
        success: false,
        errors: [{ field: 'name', message: 'Folder name already exists in this project' }]
      };
    }
  }

  const { rows } = await db.query(
    `UPDATE folders
     SET name = COALESCE($1, name),
         description = COALESCE($2, description),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3
     RETURNING id, project_id, name, description, created_at, updated_at`,
    [name, description, id]
  );
  return { success: true, data: rows[0] };
}

// Delete folder and handle related logs inside a transaction
async function deleteFolderAndHandleLogs(db, folderId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: folderRows } = await client.query('SELECT id FROM folders WHERE id = $1', [folderId]);
    if (folderRows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, notFound: true };
    }

    // Giả định bạn có hàm nullifyFolderTree để xử lý các foreign key trong bảng log
    await logSvc.nullifyFolderTree(folderId, client);

    await client.query('DELETE FROM folders WHERE id = $1', [folderId]);

    await client.query('COMMIT');
    return { success: true, data: { id: folderId } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolderAndHandleLogs,
};