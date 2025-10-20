// src/controllers/project_request_log.controller.js
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

exports.getLogById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await service.getLogById(req.db.stateless, id);
    if (!row) return res.status(404).json({ message: "Not found" });
    return res.status(200).json(row);
  } catch (err) {
    console.error("[project_request_logs] getOne error:", err);
    return res.status(500).json({ message: "Internal Server Error", error: err.message });
  }
};
