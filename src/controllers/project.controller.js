const svc = require("../services/project.service");
const { success, error } = require("../utils/response");

// List all projects (optionally filter by workspace_id)
async function listProjects(req, res) {
  try {
    const { workspace_id } = req.query;
    const result = await svc.getProjects(req.db.stateless, workspace_id);
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}
// Get project by id
async function getProjectById(req, res) {
  try {
    const result = await svc.getProjectById(req.db.stateless, req.params.id);
    if (!result.data) {
      return error(res, 404, "Project not found");
    }
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Create project
async function createProject(req, res) {
  try {
    const result = await svc.createProject(req.db.stateless, req.body);
    if (result.success === false) {
      return res.status(400).json(result);
    }
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Update project
async function updateProject(req, res) {
  try {
    const { websocket_enabled, ...rest } = req.body || {};
    const onlyWsToggle = typeof websocket_enabled !== "undefined" && (Object.keys(rest).length === 0 || (rest.name == null && rest.description == null));
    // Chỉ bật/tắt WS (không đổi name/description)
    if (onlyWsToggle) {
      const result = await svc.updateProjectWebsocketEnabled(req.db.stateless, parseInt(req.params.id, 10), Boolean(websocket_enabled));
      if (result.notFound) {
        return error(res, 404, "Project not found");
      }
      return success(res, result.data);
    }

    // Flow cũ: cập nhật name/description (service đã tự validate name nếu có)
    const result = await svc.updateProject(req.db.stateless, req.params.id, req.body);
    if (result.notFound) {
      return error(res, 404, "Project not found");
    }
    if (result.success === false) {
      return res.status(400).json(result);
    }
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Update only websocket_enabled
async function updateProjectWebsocketEnabledCtrl(req, res) {
  try {
    const { id } = req.params;
    const { websocket_enabled } = req.body || {};
    const result = await svc.updateProjectWebsocketEnabled(req.db.stateless, parseInt(id, 10), Boolean(websocket_enabled));
    if (result.notFound) {
      return error(res, 404, "Project not found");
    }
    return success(res, result.data);
  } catch (err) {
    return error(res, 500, err.message);
  }
}

// Delete project (KHÔNG ghi log xoá; chỉ NULL hoá các tham chiếu trong bảng log để tránh lỗi FK)
const logSvc = require("../services/project_request_log.service");
async function deleteProject(req, res) {
  try {
    const { id } = req.params;
    const result = await svc.deleteProjectAndHandleLogs(req.db.stateless, parseInt(id, 10));
    if (result.notFound) {
      return error(res, 404, "Project not found");
    }
    return success(res, { message: `Project with ID: ${id} has been deleted.` });
  } catch (err) {
    return error(res, 500, err.message);
  }
}

module.exports = {
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
};
