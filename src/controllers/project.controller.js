const svc = require('../services/project.service');

// List all projects (optionally filter by workspace_id)
async function listProjects(req, res) {
  try {
    const { workspace_id } = req.query;
    const data = await svc.getProjects(workspace_id);
    return res.status(200).json(data); // array object trần
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Get project by id
async function getProjectById(req, res) {
  try {
    const data = await svc.getProjectById(req.params.id);
    if (!data) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Project not found' }]
      });
    }
    return res.status(200).json(data); // object trần
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Create project
async function createProject(req, res) {
  try {
    const result = await svc.createProject(req.body);
    if (!result || result.success === false) {
      return res.status(400).json(result || {
        success: false,
        errors: [{ field: 'general', message: 'Create failed' }]
      });
    }
    return res.status(200).json(result); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Update project
async function updateProject(req, res) {
  try {
    const result = await svc.updateProject(req.params.id, req.body);
    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Project not found' }]
      });
    }
    if (result.success === false) {
      return res.status(400).json(result);
    }
    return res.status(200).json(result); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Delete project (KHÔNG ghi log xoá; chỉ NULL hoá các tham chiếu trong bảng log để tránh lỗi FK)
const logSvc = require('../services/project_request_log.service');
async function deleteProject(req, res) {
  try {
    const { id } = req.params;
    const pid = parseInt(id, 10);

    // Kiểm tra tồn tại trước khi xoá
    const exist = await svc.getProjectById(pid);
    if (!exist) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Project not found' }]
      });
    }

    // NULL hoá toàn bộ tham chiếu liên quan project trong bảng log
    try { await logSvc.nullifyProjectTree(pid); } catch (_) {}

    // Xoá project
    const result = await svc.deleteProject(pid);
    return res.status(200).json(result); // object trần { id: ... }
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

module.exports = {
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject
};
