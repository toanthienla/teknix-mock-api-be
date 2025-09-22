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

// Delete endpoint (giữ log: NULL hoá FK trước, rồi ghi log DELETE)
// Bước 1: NULL hoá endpoint_id và endpoint_response_id thuộc endpoint trong bảng log
// Bước 2: Xoá endpoint
// Bước 3: Ghi 1 dòng log DELETE để truy vết hành động
const logSvc = require('../services/project_request_log.service');
async function deleteEndpoint(req, res) {
  const started = Date.now();
  try {
    const { id } = req.params;
    const eid = parseInt(id, 10);
    const urlPath = req.originalUrl || req.path || '';
    const headersReq = req.headers || {};
    const bodyReq = req.body || {};
    const ip = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || '').toString().split(',')[0].trim().substring(0,45);

    // Lấy endpoint để suy ra project_id trước khi xoá
    const current = await svc.getEndpointById(eid);
    if (!current) {
      // Ghi log 404 cho action DELETE
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

    // NULL hoá tham chiếu trong project_request_logs: endpoint_id & endpoint_response_id thuộc endpoint
    try { await logSvc.nullifyEndpointAndResponses(eid); } catch (_) {}

    // Xoá endpoint (KHÔNG ghi log xoá theo yêu cầu)
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
