const svc = require("../services/folder.service");
const { success, error } = require("../utils/response");
const auth = require("../middlewares/authMiddleware");
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
    const { project_id, name, description, is_public } = req.body;

    // Nếu payload không có is_public → mặc định là false
    const isPublicValue = typeof is_public !== "undefined" ? Boolean(is_public) : false;

    const result = await svc.createFolder(req.db.stateless, {
      project_id: parseInt(project_id, 10),
      name: name.trim(),
      description: description ?? null,
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
// Update folder
async function updateFolder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return error(res, 400, "id must be an integer");
    }
    // 🧩 Phân biệt loại update (dựa vào sự tồn tại của key)
    const payload = req.body;
    const hasSchemaKey = Object.prototype.hasOwnProperty.call(payload, 'base_schema');

    const result = await svc.updateFolder(
      req.db.stateless,
      hasSchemaKey ? req.db.stateful : null,
      id,
      payload
    );

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

    // Xóa folder trong transaction (không cần owner-check)
    const result = await svc.deleteFolderAndHandleLogs(req.db.stateless, id);

    if (result.notFound) {
      return error(res, 404, "Folder not found");
    }

    return success(res, { deleted_id: id });
  } catch (err) {
    return error(res, 500, err.message);
  }
}

module.exports = {
  listFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolder,
};
