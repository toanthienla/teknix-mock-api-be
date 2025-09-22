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

// Delete workspace (giữ log: NULL hoá toàn bộ tham chiếu trong cây workspace, rồi ghi log DELETE)
// Bước 1: NULL hoá project_id/endpoint_id/endpoint_response_id cho toàn bộ thực thể thuộc workspace trong bảng log
// Bước 2: Xoá workspace
// Bước 3: Ghi 1 dòng log DELETE để truy vết
const logSvc = require('../services/project_request_log.service');
async function deleteWorkspace(req, res) {
  const started = Date.now();
  try {
    const { id } = req.params;
    const wid = parseInt(id, 10);
    const urlPath = req.originalUrl || req.path || '';
    const headersReq = req.headers || {};
    const bodyReq = req.body || {};
    const ip = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || '').toString().split(',')[0].trim().substring(0,45);

    // Kiểm tra tồn tại
    const exists = await svc.getWorkspaceById(wid);
    if (!exists) {
      try {
        await logSvc.insertLog({
          project_id: null,
          endpoint_id: null,
          endpoint_response_id: null,
          request_method: 'DELETE',
          request_path: urlPath,
          request_headers: headersReq,
          request_body: bodyReq,
          response_status_code: 404,
          response_body: { error: { message: 'Workspace not found' } },
          ip_address: ip,
          latency_ms: 0,
        });
      } catch (_) {}
      return res.status(404).json({
        success: false,
        errors: [{ field: 'id', message: 'Workspace not found' }]
      });
    }

    // NULL hoá tham chiếu ở toàn bộ cây workspace
    try { await logSvc.nullifyWorkspaceTree(wid); } catch (_) {}

    // Xoá workspace (KHÔNG ghi log xoá theo yêu cầu)
    const result = await svc.deleteWorkspace(wid);
    return res.status(200).json(result);
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
