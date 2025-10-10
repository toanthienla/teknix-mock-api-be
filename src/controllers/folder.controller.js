const svc = require("../services/folder.service");
const { success, error } = require("../utils/response");
const auth = require('../middlewares/authMiddleware');
// List all folders (optionally filter by project_id)
async function listFolders(req, res) {
  try {
    const { project_id } = req.query;
    let pid = null;

    // Chỉ validate và gán pid nếu project_id được cung cấp
    if (project_id) {
      const parsedId = parseInt(project_id, 10);
      if (Number.isNaN(parsedId)) {
        return error(res, 400, "project_id must be an integer");
      }
      pid = parsedId;
    }

    const result = await svc.getFolders(req.db.stateless, pid);
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Get folder by id
async function getFolderById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return error(res, 400, "id must be an integer");
    }

    const result = await svc.getFolderById(req.db.stateless, id);
    if (!result.data) {
      return error(res, 404, "Folder not found");
    }
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Create new folder
async function createFolder(req, res) {
  try {
    console.log('🟡 req.user:', req.user);
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized: missing user info' });
    }

    const { project_id, name, description, is_public } = req.body;

    // Nếu payload không có is_public → mặc định là false
    const isPublicValue = typeof is_public !== 'undefined' ? Boolean(is_public) : false;

    const result = await svc.createFolder(req.db.stateless, {
      project_id: parseInt(project_id, 10),
      name: name.trim(),
      description: description ?? null,
      user_id: userId,
      is_public: isPublicValue,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    return success(res, result.data, 201); // Created
  } catch (err) {
    return error(res, 500, err.message);
  }
}


// Update folder
async function updateFolder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return error(res, 400, "id must be an integer");
    }

    const userId = req.user?.user_id;
    if (!userId) {
      return error(res, 401, "Unauthorized: missing user info");
    }

    // Kiểm tra quyền sở hữu trước khi update
    const { rows } = await req.db.stateless.query(
      'SELECT user_id FROM folders WHERE id = $1',
      [id]
    );

    if (rows.length === 0) {
      return error(res, 404, "Folder not found");
    }

    const folder = rows[0];
    if (folder.user_id !== userId) {
      return error(res, 403, "Forbidden: you do not own this folder");
    }

    // Cho phép update
    const result = await svc.updateFolder(req.db.stateless, id, req.body);

    if (result.notFound) {
      return error(res, 404, "Folder not found");
    }
    if (result.success === false) {
      return res.status(400).json(result);
    }

    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}


async function deleteFolder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return error(res, 400, "id must be an integer");
    }

    const userId = req.user?.user_id;
    if (!userId) {
      return error(res, 401, "Unauthorized: missing user info");
    }

    // Kiểm tra quyền sở hữu folder
    const { rows } = await req.db.stateless.query(
      'SELECT user_id FROM folders WHERE id = $1',
      [id]
    );

    if (rows.length === 0) {
      return error(res, 404, "Folder not found");
    }

    const folder = rows[0];
    if (folder.user_id !== userId) {
      return error(res, 403, "Forbidden: you do not own this folder");
    }

    // Xóa folder trong transaction
    const result = await svc.deleteFolderAndHandleLogs(req.db.stateless, id);

    if (result.notFound) {
      return error(res, 404, "Folder not found");
    }

    return success(res, { deleted_id: id });
  } catch (err) {
    return error(res, 500, err.message);
  }
}

async function getFolderOwner(req, res) {
  try {
    const { id } = req.params;
    const result = await svc.getFolderOwnerById(req.db.stateless, id);

    if (result.success === false) {
      return res.status(404).json(result);
    }

    return success(res, result.data);
  } catch (err) {
    console.error("Error fetching folder owner:", err);
    return res.status(500).json({
      success: false,
      errors: [{ field: "general", message: "Internal server error" }],
    });
  }
}

// GET /folders/checkOwner/:id
async function checkFolderOwner(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.user_id; // Lấy user_id từ JWT middleware

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Missing user info from token",
      });
    }

    const result = await svc.checkFolderOwner(req.db.stateless, id, userId);

    // Nếu folder không tồn tại hoặc user không phải chủ
    if (!result.success) {
      return res.status(200).json({
        success: false,
        message: result.message,
      });
    }

    // Nếu đúng là chủ
    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
}

module.exports = {
  listFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolder,
  getFolderOwner,
  checkFolderOwner,
};
