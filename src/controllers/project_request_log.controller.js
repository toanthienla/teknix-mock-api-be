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

    // New query params
    const rawTimeRange = req.query.time_range ? String(req.query.time_range) : null;
    const rawSearch = req.query.search ? String(req.query.search) : null;

    // Ưu tiên date_from/date_to nếu được truyền tay
    let dateFrom = req.query.date_from ? String(req.query.date_from) : null;
    let dateTo = req.query.date_to ? String(req.query.date_to) : null;

    // Nếu không truyền date_from/date_to thì mới dùng time_range
    if (!dateFrom && !dateTo && rawTimeRange) {
      const now = new Date();
      switch (rawTimeRange) {
        case "24h":
          dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
          break;
        case "7d":
          dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
          break;
        case "30d":
          dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
          break;
        case "recent":
        default:
          // recent hoặc value lạ thì không filter thời gian
          break;
      }
    }

    const search = rawSearch && rawSearch.trim() !== "" ? rawSearch.trim() : null;

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
      search,
    });

    return res.status(200).json({ count: result.count, items: result.items });
  } catch (err) {
    console.error("[project_request_logs] list error:", err);
    return res.status(500).json({ message: "Internal Server Error", error: err.message });
  }
};

// GET /project_request_logs/project/:id → trả danh sách logs theo project_id
exports.getLogsByProjectId = async (req, res) => {
  console.log(">>> [Controller] getLogsByProjectId called");
  try {
    // hỗ trợ cả query ?project_id= lẫn param /project/:id (nếu sau này dùng đúng như comment)
    const projectId = toInt(req.query.project_id ?? req.params.id);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    if (!projectId) {
      return res.status(400).json({ message: "Invalid project_id" });
    }

    const offset = (page - 1) * limit;

    // New query params
    const rawTimeRange = req.query.time_range ? String(req.query.time_range) : null;
    const rawSearch = req.query.search ? String(req.query.search) : null;

    let dateFrom = null;
    let dateTo = null;

    if (rawTimeRange) {
      const now = new Date();
      switch (rawTimeRange) {
        case "24h":
          dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
          break;
        case "7d":
          dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
          break;
        case "30d":
          dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
          break;
        case "recent":
        default:
          break;
      }
    }

    const search = rawSearch && rawSearch.trim() !== "" ? rawSearch.trim() : null;

    // Dùng lại service.listLogs để đồng bộ logic Project Logs
    const { count, items } = await service.listLogs(req.db.stateless, {
      projectId,
      dateFrom,
      dateTo,
      limit,
      offset,
      search,
    });

    const total = count;

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      count: items.length,
      items,
    });
  } catch (err) {
    console.error("[project_request_logs] getLogsByProjectId error:", err);
    return res.status(500).json({
      message: "Internal Server Error",
      error: err.message,
    });
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
