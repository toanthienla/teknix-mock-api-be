const svc = require('../services/workspace.service');
const { success } = require('../utils/response');

// List all workspaces
async function listWorkspaces(req, res) {
  try {
    const data = await svc.getAllWorkspaces();
    return success(res, data); // trả về array object trần
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Get workspace by id
async function getWorkspace(req, res) {
  try {
    const data = await svc.getWorkspaceById(req.params.id);
    if (!data) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Workspace not found' }]
      });
    }
    return success(res, data); // object trần
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Create workspace (validate-format đã handled ở middleware)
async function createWorkspace(req, res) {
  try {
    const result = await svc.createWorkspace(req.body);
    if (result.success === false) {
      return res.status(400).json(result); // errors array
    }
    return success(res, result.data); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Update workspace (validate-format đã handled ở middleware)
async function updateWorkspace(req, res) {
  try {
    const result = await svc.updateWorkspace(req.params.id, req.body);
    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Workspace not found' }]
      });
    }
    if (result.success === false) {
      return res.status(400).json(result); // errors array
    }
    return success(res, result.data); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Delete workspace
async function deleteWorkspace(req, res) {
  try {
    const result = await svc.deleteWorkspace(req.params.id);
    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Workspace not found' }]
      });
    }
    return success(res, result.data); // trả object trần trước khi xóa
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

module.exports = { 
  listWorkspaces, 
  getWorkspace, 
  createWorkspace, 
  updateWorkspace, 
  deleteWorkspace 
};
