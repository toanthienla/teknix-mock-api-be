const service = require("../services/project_request_log.service");

function toInt(v, fallback = null) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseTimeRange(rawTimeRange) {
  if (!rawTimeRange) return { dateFrom: null, dateTo: null };

  // Giữ đặc biệt cho "recent" nếu bạn muốn dùng để chỉ "không filter"
  if (rawTimeRange === "recent") {
    return { dateFrom: null, dateTo: null };
  }

  // Hỗ trợ pattern: <number><unit>  (vd: 1h, 2h, 3d, 10d, 72h,...)
  const m = /^(\d+)([hd])$/.exec(rawTimeRange);
  if (!m) {
    // format lạ -> bỏ qua filter time
    return { dateFrom: null, dateTo: null };
  }

  const value = parseInt(m[1], 10);
  const unit = m[2];

  if (!value || value <= 0) {
    return { dateFrom: null, dateTo: null };
  }

  // ✅ Sử dụng Date.now() để lấy UTC timestamp, tránh vấn đề timezone
  // Database lưu trữ timestamp ở UTC, nên cần so sánh với UTC time
  const now = Date.now();
  let ms = 0;

  if (unit === "h") {
    ms = value * 60 * 60 * 1000; // giờ
  } else if (unit === "d") {
    ms = value * 24 * 60 * 60 * 1000; // ngày
  }

  const dateFrom = new Date(now - ms).toISOString();
  // dateTo có thể để null, service đang chỉ check >= dateFrom
  return { dateFrom, dateTo: null };
}

exports.listLogs = async (req, res) => {
  try {
    const projectId = toInt(req.query.project_id);
    const endpointId = toInt(req.query.endpoint_id);
    const statusCode = toInt(req.query.status_code);

    // HỖ TRỢ THÊM page, nhưng vẫn giữ limit/offset cũ
    const pageFromQuery = toInt(req.query.page, null);
    let limit = toInt(req.query.limit, 100);
    let offset = toInt(req.query.offset, 0);

    if (pageFromQuery && pageFromQuery > 0) {
      // Nếu FE truyền page thì ưu tiên page, tính lại offset
      offset = (pageFromQuery - 1) * limit;
    }

    const method = req.query.method ? String(req.query.method).toUpperCase() : null;

    // Latency filter (ms)
    const minLatency = toInt(req.query.min_latency);
    const maxLatency = toInt(req.query.max_latency);
    // latency: "32" hoặc "32,200,500" (multiple values)
    let latencyExact = null;
    if (req.query.latency) {
      const rawExact = String(req.query.latency).trim();
      if (rawExact) {
        latencyExact = rawExact
          .split(",")
          .map((v) => toInt(v))
          .filter((v) => v != null);
        if (latencyExact.length === 0) latencyExact = null;
      }
    }

    // New query params
    const rawTimeRange = req.query.time_range ? String(req.query.time_range) : null;
    const rawSearch = req.query.search ? String(req.query.search) : null;

    // Ưu tiên date_from/date_to nếu được truyền tay
    let dateFrom = req.query.date_from ? String(req.query.date_from) : null;
    let dateTo = req.query.date_to ? String(req.query.date_to) : null;

    // Nếu không truyền date_from/date_to thì mới dùng time_range (1h, 2h, 3d, 33d,...)
    if (!dateFrom && !dateTo && rawTimeRange) {
      const parsed = parseTimeRange(rawTimeRange);
      dateFrom = parsed.dateFrom;
      dateTo = parsed.dateTo;
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
      minLatency,
      maxLatency,
      latencyExact,
      limit,
      offset,
      search,
    });

    const total = result.count; // tổng số record sau filter (toàn bộ)
    const items = result.items || []; // danh sách record trong trang hiện tại
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
    const currentPage = limit > 0 ? Math.floor(offset / limit) + 1 : 1;

    return res.status(200).json({
      page: currentPage,
      limit,
      total,
      totalPages,
      count: items.length, // số bản ghi trong trang hiện tại
      items,
    });
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
      const parsed = parseTimeRange(rawTimeRange);
      dateFrom = parsed.dateFrom;
      dateTo = parsed.dateTo;
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
