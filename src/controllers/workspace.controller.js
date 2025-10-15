const svc = require("../services/workspace.service");
const { success, error } = require("../utils/response");

// List all workspaces
async function listWorkspaces(req, res) {
  try {
    // Service trả về { success: true, data: [...] }
    const result = await svc.getAllWorkspaces(req.db.stateless);
    // Chỉ trả về mảng data
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Get workspace by id
async function getWorkspace(req, res) {
  try {
    // Service trả về { success: true, data: {...} }
    const result = await svc.getWorkspaceById(req.db.stateless, req.params.id);

    // Sửa lỗi logic: kiểm tra thuộc tính .data thay vì toàn bộ object result
    if (!result.data) {
      return error(res, 404, "Workspace not found");
    }

    // Chỉ trả về object data
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Create workspace
async function createWorkspace(req, res) {
  try {
    const result = await svc.createWorkspace(req.db.stateless, req.body);
    if (!result || result.success === false) {
      return res.status(400).json(
        result || {
          success: false,
          errors: [{ field: "general", message: "Create failed" }],
        }
      );
    }
    return res.status(200).json(result); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: "general", message: err.message }],
    });
  }
}

// Update workspace
async function updateWorkspace(req, res) {
  try {
    const result = await svc.updateWorkspace(req.db.stateless, req.params.id, req.body);
    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: "id", message: "Workspace not found" }],
      });
    }
    if (result.success === false) {
      return res.status(400).json(result); // errors array
    }
    return res.status(200).json(result); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: "general", message: err.message }],
    });
  }
}

// Delete workspace (giữ log: NULL hoá toàn bộ tham chiếu trong cây workspace, rồi ghi log DELETE)
// Bước 1: NULL hoá project_id/endpoint_id/endpoint_response_id cho toàn bộ thực thể thuộc workspace trong bảng log
// Bước 2: Xoá workspace
// Bước 3: Ghi 1 dòng log DELETE để truy vết
const logSvc = require("../services/project_request_log.service");
async function deleteWorkspace(req, res) {
  try {
    const { id } = req.params;
    const result = await svc.deleteWorkspaceAndHandleLogs(req.db.stateless, parseInt(id, 10));

    if (result.notFound) {
      return error(res, 404, "Workspace not found");
    }

    return success(res, { message: `Workspace with ID: ${id} has been deleted.` });
  } catch (err) {
    return error(res, 500, err.message);
  }
}

module.exports = {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
};
