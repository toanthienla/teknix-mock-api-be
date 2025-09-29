const svc = require('../services/endpoint.service');
const { success, error } = require('../utils/response');

// List all endpoints (optionally filter by folder_id)
async function listEndpoints(req, res) {
  try {
    const { folder_id } = req.query;
    const endpoints = await svc.getEndpoints(folder_id);
    return success(res, endpoints);
  } catch (err) {
    return res.status(500).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

async function listEndpointsByQuery(req, res) {
  try {
    const { folder_id } = req.query;

    if (!folder_id) {
      return error(res, 400, 'Query parameter folder_id is required');
    }

    const id = parseInt(folder_id, 10);
    if (Number.isNaN(id)) {
      return error(res, 400, 'folder_id must be an integer');
    }

    const endpoints = await svc.getEndpoints(id);
    return success(res, endpoints);
  } catch (err) {
    return error(res, 400, err.message);
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
    const { folder_id, name, method, path } = req.body;
    const errors = [];

    // Validate required fields
    if (!folder_id) errors.push({ field: 'folder_id', message: 'Folder ID is required' });
    if (!name) errors.push({ field: 'name', message: 'Endpoint name is required' });
    if (!method) errors.push({ field: 'method', message: 'HTTP method is required' });
    if (!path) errors.push({ field: 'path', message: 'Path is required' });

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const result = await svc.createEndpoint({ folder_id, name, method, path });

    if (result.success === false) {
      return res.status(400).json(result);
    }

    return success(res, result.data); // plain object
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

    return success(res, result.data); // plain object
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'general', message: err.message }]
    });
  }
}

// Delete endpoint (keep logs: nullify FKs first, then delete)
const logSvc = require('../services/project_request_log.service');
async function deleteEndpoint(req, res) {
  try {
    const { id } = req.params;
    const eid = parseInt(id, 10);
    const urlPath = req.originalUrl || req.path || '';
    const headersReq = req.headers || {};
    const bodyReq = req.body || {};
    const ip = (
      req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      req.ip ||
      ''
    )
      .toString()
      .split(',')[0]
      .trim()
      .substring(0, 45);

    // Get endpoint before deleting
    const current = await svc.getEndpointById(eid);
    if (!current) {
      // Log 404 for DELETE action
      try {
        await logSvc.insertLog({
          project_id: null,
          endpoint_id: eid || null,
          endpoint_response_id: null,
          request_method: 'DELETE',
          request_path: urlPath,
          request_headers: headersReq,
          request_body: bodyReq,
          response_status_code: 404,
          response_body: { error: { message: 'Endpoint not found' } },
          ip_address: ip,
          latency_ms: 0,
        });
      } catch (_) {}
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Endpoint not found' }]
      });
    }

    // Nullify references in project_request_logs
    try {
      await logSvc.nullifyEndpointAndResponses(eid);
    } catch (_) {}

    // Delete endpoint
    const result = await svc.deleteEndpoint(eid);
    return success(res, result.data);
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
