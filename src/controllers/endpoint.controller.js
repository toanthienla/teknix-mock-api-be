const svc = require('../services/endpoint.service');
const { success } = require('../utils/response');

// List all endpoints (optionally filter by project_id)
async function listEndpoints(req, res) {
  try {
    const { project_id } = req.query;
    const endpoints = await svc.getEndpoints(project_id);
    return success(res, endpoints);
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Get endpoint by id
async function getEndpointById(req, res) {
  try {
    const { id } = req.params;
    const endpoint = await svc.getEndpointById(id);
    if (!endpoint) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Endpoint not found' }]
      });
    }
    return success(res, endpoint);
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Create endpoint
async function createEndpoint(req, res) {
  try {
    const { project_id, name, method, path } = req.body;
    const errors = [];

    // Validate required fields
    if (!project_id) errors.push({ field: 'project_id', message: 'Project ID is required' });
    if (!name) errors.push({ field: 'name', message: 'Endpoint name is required' });
    if (!method) errors.push({ field: 'method', message: 'Method is required' });
    if (!path) errors.push({ field: 'path', message: 'Path is required' });

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const result = await svc.createEndpoint({ project_id, name, method, path });

    if (result.success === false) {
      return res.status(400).json(result);
    }

    return success(res, result.data); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Update endpoint
async function updateEndpoint(req, res) {
  try {
    const { id } = req.params;
    const { name, method, path } = req.body;

    const result = await svc.updateEndpoint(id, { name, method, path });

    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Endpoint not found' }]
      });
    }

    if (result.success === false) {
      return res.status(400).json(result);
    }

    return success(res, result.data); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Delete endpoint
async function deleteEndpoint(req, res) {
  try {
    const result = await svc.deleteEndpoint(req.params.id);

    if (!result) {
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Endpoint not found' }]
      });
    }

    return success(res, result.data); // object trần
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

module.exports = {
  listEndpointsByQuery,
  listEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint
};
