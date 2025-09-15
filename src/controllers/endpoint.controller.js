const svc = require('../services/endpoint.service');
const { success, error } = require('../utils/response');

async function listEndpointsByQuery(req, res) {
  try {
    const { project_id } = req.query;

    if (!project_id) {
      return error(res, 400, 'Cần query project_id');
    }

    const id = parseInt(project_id, 10);
    if (Number.isNaN(id)) {
      return error(res, 400, 'project_id phải là số nguyên');
    }

    const endpoints = await svc.getEndpointsByProject(id);
    return success(res, endpoints);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function listEndpoints(req, res) {
  try {
    const { projectId } = req.params;
    const endpoints = await svc.getEndpointsByProject(projectId);
    return success(res, endpoints);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function getEndpointById(req, res) {
  try {
    const { projectId, id } = req.params;
    const endpoint = await svc.getEndpointById(projectId, id);
    if (!endpoint) return error(res, 404, 'Endpoint không tồn tại');
    return success(res, endpoint);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function createEndpoint(req, res) {
  try {
    const { projectId } = req.params;
    const { name, method, path } = req.body;
    if (!name || !method || !path)
      return error(res, 400, 'Cần có name, method và path');

    const endpoint = await svc.createEndpoint(projectId, { name, method, path });
    return success(res, endpoint);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function updateEndpoint(req, res) {
  try {
    const { projectId, id } = req.params;
    const { name, method, path } = req.body;

    const updated = await svc.updateEndpoint(projectId, id, {
      name,
      method,
      path
    });
    return success(res, updated);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function deleteEndpoint(req, res) {
  try {
    const { projectId, id } = req.params;
    await svc.deleteEndpoint(projectId, id);
    return success(res, {});
  } catch (err) {
    return error(res, 400, err.message);
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
