const svc = require('../services/workspace.service');

// List all workspaces
async function listWorkspaces(req, res) {
  try {
    const data = await svc.getAllWorkspaces();
    return res.status(200).json(data); // array object trần
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
    return res.status(200).json(data); // object trần
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Create workspace
async function createWorkspace(req, res) {
  try {
    const result = await svc.createWorkspace(req.body);
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

// Update workspace
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
    return res.status(200).json(result); // object trần
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
    return res.status(200).json(result); // object trần { id: ... }
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
