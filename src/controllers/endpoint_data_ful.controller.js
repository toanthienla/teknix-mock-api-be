const EndpointStatefulService = require("../services/endpoints_ful.service");
const DataStatefulService = require("../services/endpoint_data_ful.service");
const ResponseSvc = require('../services/endpoint_response.service');

// Parse workspace/project/path từ query:
//  - Dạng tách:  ?workspace=WP_3&project=pj_3&path=/cat
//  - Dạng gộp:   ?path=WP_3/pj_3/cat
function parseWPPath(req) {
  const ensureLeadingSlash = (p) => (p && p.startsWith('/') ? p : '/' + (p || ''));
  const splitWP = (raw) => {
    if (!raw) return null;
    const clean = String(raw).replace(/^\/+/, '');
    const segs = clean.split('/').filter(Boolean);
    if (segs.length >= 3) {
      const ws = decodeURIComponent(segs[0]);
      const pj = decodeURIComponent(segs[1]);
      const rest = '/' + segs.slice(2).join('/');
      return { ws, pj, rest };
    }
    return null;
  };

  let { path, workspace, project } = req.query || {};
  const opts = {};

  // Ưu tiên dạng tách
  if (workspace && project) {
    opts.workspaceName = String(workspace);
    opts.projectName = String(project);
    return { pgPath: ensureLeadingSlash(path), opts };
  }
  // Thử dạng gộp
  const parsed = splitWP(path);
  if (parsed) {
    opts.workspaceName = parsed.ws;
    opts.projectName = parsed.pj;
    return { pgPath: parsed.rest, opts };
  }
  // Fallback legacy: chỉ có path
  return { pgPath: ensureLeadingSlash(path), opts };
}

/**
 * Lấy dữ liệu stateful theo path
 */
exports.getDataByPath = async (req, res) => {
  try {
    const { pgPath, opts } = parseWPPath(req);
    if (!pgPath) return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });

    // Dùng service endpoints_ful để đảm bảo lookup theo /path và đọc đúng collection WS/Project
    const data = await EndpointStatefulService.getEndpointData(pgPath, opts);
    return res.status(200).json(data);
  } catch (err) {
    console.error("Error in getDataByPath:", err.message);
    const status = /không tìm thấy/i.test(err.message) ? 404 : 500;
    res.status(status).json({ error: err.message || "Lỗi máy chủ nội bộ." });
  }
};

/**
 * Xóa dữ liệu stateful theo path
 * Chức năng này cũng chưa có trong service, cần bổ sung
 */
exports.deleteDataByPath = async (req, res) => {
  try {
   const { pgPath, opts } = parseWPPath(req);
    if (!pgPath) return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });

    if (typeof EndpointStatefulService.deleteEndpointData === 'function') {
      const ok = await EndpointStatefulService.deleteEndpointData(pgPath, opts);
      if (!ok) return res.status(404).json({ error: `Không tìm thấy dữ liệu với path: '${pgPath}'` });
     return res.status(204).send();
   }
    // Fallback sang data service cũ nếu bạn chưa implement xoá trong endpoints_ful.service
    const ok = await DataStatefulService.deleteByPath(pgPath, opts);
    if (!ok) return res.status(404).json({ error: `Không tìm thấy dữ liệu với path: '${pgPath}'` });
    return res.status(204).send();
  } catch (err) {
    console.error("Error in deleteDataByPath:", err.message);
    const status = /không tìm thấy/i.test(err.message) ? 404 : 500;
    res.status(status).json({ error: err.message || "Lỗi máy chủ nội bộ." });
  }
};

/**
 * Cập nhật dữ liệu (schema và data_default) cho một endpoint
 */
exports.updateEndpointData = async (req, res) => {
  try {
    const { pgPath, opts } = parseWPPath(req);
    if (!pgPath) return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "Request body không được để trống." });
    }

    const { schema, data_default } = req.body;

    const result = await EndpointStatefulService.updateEndpointData(pgPath, {
      schema,
      data_default,
    }, opts);

    return res.status(200).json({
      message: "Cập nhật dữ liệu endpoint thành công.",
      data: result,
    });
  } catch (err) {
    console.error("Error in updateEndpointData:", err.message);
    const statusCode = /không tìm thấy/i.test(err.message) ? 404 : 500;
    return res.status(statusCode).json({ error: err.message });
  }
};

/**
 * Thiết lập dữ liệu hiện tại làm dữ liệu mặc định
 */
exports.setDefaultEndpointData = async (req, res) => {
  try {
    const { pgPath, opts } = parseWPPath(req);
    const { data_default } = req.body || {};

   if (!pgPath) return res.status(400).json({ error: "Thiếu query 'path'." });
    if (data_default === undefined) return res.status(400).json({ error: "Thiếu 'data_default' trong payload." });

    // Nếu service data hỗ trợ sync current, ưu tiên dùng
    if (typeof DataStatefulService.upsertDefaultAndCurrentByPath === 'function') {
      const result = await DataStatefulService.upsertDefaultAndCurrentByPath(pgPath, data_default, opts);
      return res.status(200).json({
        message: "Cập nhật data_default và đồng bộ data_current thành công.",
        data: result,
      });
    }

    // Fallback: chỉ set data_default qua endpoints service
    const result = await EndpointStatefulService.updateEndpointData(pgPath, { data_default }, opts);
    return res.status(200).json({
      message: "Đã cập nhật data_default (không đồng bộ data_current vì service chưa hỗ trợ).",
      data: result,
    });
  } catch (err) {
    console.error("Error in setDefaultEndpointData:", err);
    const status = /không tìm thấy/i.test(err.message) ? 404 : 500;
    return res.status(status).json({ error: err.message });
  }
};