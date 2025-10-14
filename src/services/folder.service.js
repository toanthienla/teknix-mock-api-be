const logSvc = require('./project_request_log.service');

// Get all folders (optionally filter by project_id)
async function getFolders(db, project_id) {
  let query = `
    SELECT id, project_id, name, description, created_at, updated_at
    FROM folders
  `;
  const params = [];

  // Nếu có project_id, thêm điều kiện WHERE để lọc
  if (project_id) {
    query += ' WHERE project_id = $1';
    params.push(project_id);
  }

  query += ' ORDER BY id ASC';

  const { rows } = await db.query(query, params);
  return { success: true, data: rows };
}

// Get folder by id
async function getFolderById(db, id) {
  const { rows } = await db.query(
    `SELECT id, project_id, name, description, created_at, updated_at, is_public
     FROM folders
     WHERE id = $1`,
    [id]
  );
  return { success: true, data: rows[0] || null };
}

async function createFolder(db, { project_id, name, description, user_id, is_public }) {
  // Kiểm tra trùng tên trong cùng project của cùng user
  const { rows: existRows } = await db.query(
    `SELECT id 
     FROM folders 
     WHERE project_id = $1 AND user_id = $2 AND LOWER(name) = LOWER($3)`,
    [project_id, user_id, name]
  );

  if (existRows.length > 0) {
    return {
      success: false,
      errors: [{ field: 'name', message: 'Folder name already exists in this project' }],
    };
  }

  const { rows } = await db.query(
    `INSERT INTO folders (project_id, user_id, name, description, is_public)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, user_id, name, description, is_public, created_at, updated_at`,
    [project_id, user_id, name, description, is_public]
  );

  return { success: true, data: rows[0] };
}



async function updateFolder(dbStateless, dbStateful, id, payload) {
  const { name, description, is_public, base_schema } = payload;

  // 🧱 1️⃣ Kiểm tra folder có tồn tại không
  const { rows: currentRows } = await dbStateless.query(
    'SELECT * FROM folders WHERE id = $1',
    [id]
  );
  if (currentRows.length === 0) {
    return { success: false, notFound: true };
  }

  const folder = currentRows[0];

  // 🚦 2️⃣ Nếu người dùng gửi base_schema → xử lý riêng
  if (base_schema) {
    if (!dbStateful) {
      return { success: false, message: "Stateful DB connection required" };
    }

    if (typeof base_schema !== "object" || Array.isArray(base_schema)) {
      return { success: false, message: "Invalid base_schema format" };
    }

    // ✅ Cập nhật base_schema trước
    const { rows } = await dbStateless.query(
      `UPDATE folders
       SET base_schema = $1::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, project_id, user_id, name, description, is_public, base_schema, created_at, updated_at`,
      [JSON.stringify(base_schema), id]
    );

    const updatedFolder = rows[0];

    // 🔍 3️⃣ Sau khi update, kiểm tra xem có endpoint nào đã được chuyển stateful chưa
    const { rows: endpoints } = await dbStateless.query(
      'SELECT id, path FROM endpoints WHERE folder_id = $1',
      [id]
    );

    if (endpoints.length > 0) {
      const endpointIds = endpoints.map(e => e.id);
      const { rows: used } = await dbStateful.query(
        'SELECT id, origin_id FROM endpoints_ful WHERE origin_id = ANY($1)',
        [endpointIds]
      );

      // ⚙️ Nếu có endpoint stateful → gọi reset Mongo collections
      if (used.length > 0) {
        try {
          await resetMongoCollectionsByFolder(id, base_schema);
        } catch (err) {
          console.error("Error resetting Mongo collections:", err);
        }
      }
    }

    return { success: true, data: updatedFolder };
  }

  // 🧱 4️⃣ Nếu không có base_schema → giữ nguyên logic cũ
  if (name) {
    const { rows: existRows } = await dbStateless.query(
      'SELECT id FROM folders WHERE project_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3',
      [folder.project_id, name, id]
    );
    if (existRows.length > 0) {
      return {
        success: false,
        errors: [{ field: 'name', message: 'Folder name already exists in this project' }],
      };
    }
  }

  const { rows } = await dbStateless.query(
    `UPDATE folders
     SET name = COALESCE($1, name),
         description = COALESCE($2, description),
         is_public = COALESCE($3, is_public),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING id, project_id, user_id, name, description, is_public, base_schema, created_at, updated_at`,
    [name, description, is_public, id]
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

async function getFolderOwnerById(dbPool, folderId) {
  // 1️⃣ Truy vấn để lấy user_id từ folder
  const { rows: folderRows } = await dbPool.query(
    "SELECT user_id FROM folders WHERE id = $1",
    [folderId]
  );

  if (folderRows.length === 0) {
    return {
      success: false,
      errors: [{ field: "folder_id", message: "Folder not found" }],
    };
  }

  const userId = folderRows[0].user_id;

  // 2️⃣ Truy vấn để lấy username từ bảng users
  const { rows: userRows } = await dbPool.query(
    "SELECT username FROM users WHERE id = $1",
    [userId]
  );

  if (userRows.length === 0) {
    return {
      success: false,
      errors: [{ field: "user_id", message: "User not found" }],
    };
  }

  // 3️⃣ Trả về kết quả
  return {
    success: true,
    data: { username: userRows[0].username },
  };
}

// Check if current user is owner of a folder
async function checkFolderOwner(dbPool, folderId, userId) {
  try {
    // Truy vấn folder theo ID
    const { rows } = await dbPool.query(
      "SELECT user_id FROM folders WHERE id = $1",
      [folderId]
    );

    // Nếu không tồn tại folder
    if (rows.length === 0) {
      return { success: false, message: "Folder not found" };
    }

    // So sánh với user_id trong JWT
    const isOwner = rows[0].user_id === userId;

    return { success: isOwner, message: isOwner ? "User is the folder owner" : "User is not the folder owner" };
  } catch (err) {
    throw new Error("Database query failed: " + err.message);
  }
}

module.exports = {
  getFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolderAndHandleLogs,
  getFolderOwnerById,
  checkFolderOwner,
};