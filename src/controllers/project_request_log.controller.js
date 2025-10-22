const service = require("../services/project_request_log.service");

function toInt(v, fallback = null) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

exports.listLogs = async (req, res) => {
  try {
    const projectId = toInt(req.query.project_id);
    const endpointId = toInt(req.query.endpoint_id);
    const statusCode = toInt(req.query.status_code);
    const limit = toInt(req.query.limit, 100);
    const offset = toInt(req.query.offset, 0);
    const method = req.query.method ? String(req.query.method).toUpperCase() : null;
    const dateFrom = req.query.date_from ? String(req.query.date_from) : null;
    const dateTo = req.query.date_to ? String(req.query.date_to) : null;

    // New filters
    const endpointResponseId = toInt(req.query.endpoint_response_id);
    const statefulEndpointId = toInt(req.query.stateful_endpoint_id);
    const statefulEndpointResponseId = toInt(req.query.stateful_endpoint_response_id);

    const result = await service.listLogs(req.db.stateless, {
      projectId,
      endpointId,
      statusCode,
      method,
      dateFrom,
      dateTo,
      endpointResponseId,
      statefulEndpointId,
      statefulEndpointResponseId,
      limit,
      offset,
    });

    return res.status(200).json({ count: result.count, items: result.items });
  } catch (err) {
    console.error("[project_request_logs] list error:", err);
    return res.status(500).json({ message: "Internal Server Error", error: err.message });
  }
};

// GET /project_request_logs/project/:id → trả danh sách logs theo project_id
exports.getLogsByProjectId = async (req, res) => {
  try {
    const projectId = toInt(req.params.id);
    if (!projectId) {
      return res.status(400).json({ message: "Invalid project id" });
    }

    const logs = await service.getLogsByProjectId(req.db.stateless, projectId);

    return res.status(200).json({
      count: logs.length,
      items: logs,
    });
  } catch (err) {
    console.error("[project_request_logs] getLogsByProjectId error:", err);
    return res.status(500).json({ message: "Internal Server Error", error: err.message });
  }
};

// ✅ GET /project_request_logs/:id → trả 1 log theo log_id
exports.getLogById = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid log id" });

    // GỌI SERVICE, TRUYỀN ĐÚNG pool: req.db.stateless
    const log = await service.getLogById(req.db.stateless, id);

    if (!log) return res.status(404).json({ message: "Log not found", id });
    return res.status(200).json(log);
  } catch (err) {
    console.error("[project_request_logs] getLogById error:", err);
    return res.status(500).json({ message: "Internal Server Error", error: err.message });
  }
};
