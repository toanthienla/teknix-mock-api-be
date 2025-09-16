const svc = require('../services/project.service');
const { success } = require('../utils/response');

// Get all projects (optional filter by workspace_id)
async function listProjects(req, res) {
  try {
    const { workspace_id } = req.query;
    const data = await svc.getProjects(workspace_id);
    return success(res, data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// Get project by id
async function getProjectById(req, res) {
  try {
    const data = await svc.getProjectById(req.params.id);
    if (!data) {
      return res.status(404).json({ message: 'Project not found' });
    }
    return success(res, data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// Create project
async function createProject(req, res) {
  try {
    const { workspace_id, name, description } = req.body;
    if (!workspace_id) {
      return res.status(400).json({
        success: false,
        errors: [{ field: 'workspace_id', message: 'Workspace ID is required' }]
      });
    }
    if (!name) {
      return res.status(400).json({
        success: false,
        errors: [{ field: 'name', message: 'Project name is required' }]
      });
    }

    const result = await svc.createProject({ workspace_id, name, description });
    if (result && result.success === false) {
      return res.status(400).json(result);
    }
    return success(res, result); // object trần
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
}

// Update project
async function updateProject(req, res) {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const result = await svc.updateProject(id, { name, description });
    if (!result) {
      return res.status(404).json({ message: 'Project not found' });
    }
    if (result.success === false) {
      return res.status(400).json(result);
    }
    return success(res, result); // object trần
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
}

// Delete project
async function deleteProject(req, res) {
  try {
    await svc.deleteProject(req.params.id);
    return res.json({ message: 'Project has been deleted' });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
}

module.exports = { 
  listProjects, 
  getProjectById, 
  createProject, 
  updateProject, 
  deleteProject 
};
