const svc = require('../services/workspace.service');
const { success } = require('../utils/response');

async function listWorkspaces(req, res) {
  try {
    const data = await svc.getAllWorkspaces();
    return success(res, data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

async function getWorkspace(req, res) {
  try {
    const data = await svc.getWorkspaceById(req.params.id);
    if (!data) {
      return res.status(404).json({ message: 'Workspace not found' });
    }
    return success(res, data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

async function createWorkspace(req, res) {
  try {
    const result = await svc.createWorkspace(req.body);
    if (result && result.success === false) {
      return res.status(400).json(result);
    }
    return success(res, result); // trả object trần
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
}

async function updateWorkspace(req, res) {
  try {
    const result = await svc.updateWorkspace(req.params.id, req.body);
    if (!result) {
      return res.status(404).json({ message: 'Workspace not found' });
    }
    if (result.success === false) {
      return res.status(400).json(result);
    }
    return success(res, result); // trả object trần
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
}

async function deleteWorkspace(req, res) {
  try {
    await svc.deleteWorkspace(req.params.id);
    return res.json({ message: 'Workspace has been deleted' });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
}

module.exports = { 
  listWorkspaces, 
  getWorkspace, 
  createWorkspace, 
  updateWorkspace, 
  deleteWorkspace 
};
