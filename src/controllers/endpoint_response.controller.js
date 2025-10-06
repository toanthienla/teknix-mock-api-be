// Controller cho Endpoint Responses
// Nhiệm vụ: nhận request, validate đầu vào, gọi service và trả response thống nhất
// Bao gồm: list theo endpoint_id (query), lấy chi tiết, tạo mới, cập nhật,
// cập nhật thứ tự (priority), đặt mặc định và xóa
const svc = require("../services/endpoint_response.service");
const endpointSvc = require("../services/endpoint.service");
const { success, error } = require("../utils/response");
const statefulSvc = require("../services/endpoint_responses_ful.service");
const endpointsFulSvc = require("../services/endpoints_ful.service");
const responsesFulSvc = require("../services/endpoint_responses_ful.service");

// Helper lấy IP client (ưu tiên x-forwarded-for)
function getClientIp(req) {
  const raw = (
    req.headers?.["x-forwarded-for"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip ||
    ""
  ).toString();
  const first = raw.split(",")[0].trim();
  return first.substring(0, 45);
}

// [GET] /endpoint_responses?endpoint_id=...
// Trả về danh sách response của một endpoint cụ thể
// - Validate endpoint_id phải là số nguyên
async function listByEndpointQuery(req, res) {
  try {
    const { endpoint_id } = req.query;
    if (!endpoint_id)
      return error(res, 400, "Query parameter endpoint_id is required");

    const eid = parseInt(endpoint_id, 10);
    if (Number.isNaN(eid))
      return error(res, 400, "endpoint_id must be an integer");

    // 1) Luôn kiểm tra endpoint ở DB stateless trước
    const ep = await endpointSvc.getEndpointById(req.db.stateless, eid);
    if (!ep) return error(res, 404, "Endpoint not found");

    // 2) Nếu endpoint đã chuyển stateful -> lấy responses ở DB stateful theo origin_id
    if (ep.is_stateful === true) {
      // Lấy endpoint stateful theo origin_id (KHÔNG truyền pool)
      const statefulFull = await endpointsFulSvc.findByOriginId(eid);
      if (!statefulFull) return success(res, []); // chưa có bản ghi stateful tương ứng

      // Lấy responses stateful theo endpoint_ful.id (KHÔNG truyền pool)
      const list = await responsesFulSvc.findByEndpointId(statefulFull.id);

      // Trả kèm cờ để client phân biệt
      return success(
        res,
        (list || []).map((r) => ({ ...r, is_stateful: true }))
      );
    }

    // 3) Ngược lại: stateless như bình thường
    const rows = await svc.getByEndpointId(req.db.stateless, eid);
    return success(res, rows);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [GET] /endpoint_responses/:id
// Lấy chi tiết một response theo id
// - Validate id là số nguyên
// - 404 nếu không tìm thấy
async function getById(req, res) {
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, "id must be an integer");

    // Bước 1: Lấy dữ liệu stateless
    const statelessResponse = await svc.getById(req.db.stateless, rid);
    if (!statelessResponse) return error(res, 404, "Response not found");

    // Bước 2: Kiểm tra cờ is_stateful
    if (statelessResponse.is_stateful === true) {
      const statefulResponse = await statefulSvc.findByOriginId(
        statelessResponse.id
      );
      if (!statefulResponse) {
        return error(res, 404, `Stateful data for response ${rid} not found.`);
      }
      return success(res, { ...statefulResponse, is_stateful: true });
    }

    // Bước 3: Trả về dữ liệu stateless
    return success(res, statelessResponse);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [POST] /endpoint_responses
// Tạo mới response cho endpoint
// Body yêu cầu: { endpoint_id, name, status_code, response_body, condition, is_default, delay_ms }
// Business:
//  - Nếu là response đầu tiên của endpoint → service sẽ tự set is_default = true
//  - Nếu gửi is_default = true → service sẽ unset is_default các response khác cùng endpoint
async function create(req, res) {
  try {
    const {
      endpoint_id,
      name,
      status_code,
      response_body,
      condition,
      is_default,
      delay_ms,
    } = req.body;
    if (!endpoint_id || typeof status_code === "undefined") {
      return error(res, 400, "endpoint_id and status_code are required");
    }

    // Validate name: required and not empty/whitespace-only
    if (typeof name !== "string" || name.trim().length === 0) {
      return error(res, 400, "name cannot be empty");
    }

    const eid = parseInt(endpoint_id, 10);
    if (Number.isNaN(eid))
      return error(res, 400, "endpoint_id must be an integer");

    const row = await svc.create(req.db.stateless, {
      endpoint_id: eid,
      name: name.trim(),
      status_code,
      response_body: response_body ?? {},
      condition: condition ?? {},
      is_default: Boolean(is_default),
      delay_ms: typeof delay_ms === "number" ? delay_ms : 0,
    });
    return success(res, row);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [PUT] /endpoint_responses/:id
// Cập nhật thông tin response theo id
// Body cho phép: { name, status_code, response_body, condition, is_default, delay_ms }
// Business:
//  - Nếu is_default = true → service sẽ unset is_default của response khác cùng endpoint
async function update(req, res) {
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, "id must be an integer");

    const {
      name,
      status_code,
      response_body,
      condition,
      is_default,
      delay_ms,
      proxy_url,
      proxy_method,
    } = req.body;

    // Validate name nếu có
    if (typeof name !== "undefined") {
      if (typeof name !== "string" || name.trim().length === 0) {
        return error(res, 400, "name cannot be empty");
      }
    }

    // Validate proxy_method nếu có
    if (typeof proxy_method !== "undefined" && proxy_method !== null) {
      const allowed = ["GET", "POST", "PUT", "DELETE"];
      if (!allowed.includes(proxy_method)) {
        return error(res, 400, "proxy_method is invalid");
      }
    }

    // Validate proxy_url nếu có
    if (typeof proxy_url !== "undefined" && proxy_url !== null) {
      if (typeof proxy_url !== "string" || proxy_url.trim().length === 0) {
        return error(res, 400, "proxy_url must be a valid string");
      }
      // Kiểm tra dạng URL cơ bản
      if (!/^https?:\/\//i.test(proxy_url)) {
        return error(res, 400, "proxy_url must start with http:// or https://");
      }
    }

    // Gọi service update
    const row = await svc.update(req.db.stateless, req.db.stateful, rid, {
      name: typeof name === "undefined" ? undefined : name.trim(),
      status_code,
      response_body,
      condition,
      is_default:
        typeof is_default === "undefined" ? undefined : Boolean(is_default),
      delay_ms:
        typeof delay_ms === "undefined"
          ? undefined
          : parseInt(delay_ms, 10) || 0,
      proxy_url: typeof proxy_url === "undefined" ? undefined : proxy_url,
      proxy_method:
        typeof proxy_method === "undefined" ? undefined : proxy_method,
    });

    //  Nếu không có bản ghi (service trả null) → 404
    if (!row) {
      return error(res, 404, "Response not found");
    }

    //  Nếu service throw err (ví dụ GET 200 bị chặn) → bắt ở catch
    return success(res, row);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({ error: err.message });
  }
}

// [PUT] /endpoint_responses/priority
// Cập nhật priority theo danh sách item
// Body: Array<{ id, endpoint_id, priority }>
// Lưu ý: route phải đặt trước /:id để không bị bắt nhầm
async function updatePriorities(req, res) {
  try {
    const items = req.body;
    const urlPath = req.originalUrl || req.path || "";
    const ip = getClientIp(req);
    const headersReq = req.headers || {};
    const bodyReq = req.body || {};

    // Ghi LOG cả khi lỗi 400: payload không đúng định dạng
    // Mục tiêu: vẫn lưu lại request sai định dạng vào bảng log để dễ truy vết
    if (!Array.isArray(items)) {
      const message =
        "Payload must be an array of items {id, endpoint_id, priority}";
      try {
        // Suy luận project_id từ bodyReq.endpoint_id nếu có
        let project_id = null;
        let endpoint_id = null;
        if (bodyReq && typeof bodyReq === "object" && bodyReq.endpoint_id) {
          const eid = parseInt(bodyReq.endpoint_id, 10);
          if (!Number.isNaN(eid)) {
            endpoint_id = eid;
            try {
              const ep = await endpointSvc.getEndpointById(
                req.db.stateless,
                eid
              );
              project_id = ep?.project_id ?? null;
            } catch (_) {}
          }
        }
        await logSvc.insertLog({
          project_id,
          endpoint_id,
          endpoint_response_id: null,
          request_method: req.method?.toUpperCase?.() || "PUT",
          request_path: urlPath,
          request_headers: headersReq,
          request_body: bodyReq,
          response_status_code: 400,
          response_body: { error: { message } },
          ip_address: ip,
          latency_ms: 0,
        });
      } catch (_) {}
      return error(res, 400, message);
    }
    // Basic validation
    // Nếu từng item thiếu trường bắt buộc → trả lỗi 400 và vẫn GHI LOG kèm bad_item để debug
    for (const it of items) {
      if (
        !it ||
        typeof it.id === "undefined" ||
        typeof it.endpoint_id === "undefined" ||
        typeof it.priority === "undefined"
      ) {
        const message = "Each item must include id, endpoint_id, and priority";
        try {
          let project_id = null;
          let endpoint_id = null;
          const eid = parseInt(it?.endpoint_id, 10);
          if (!Number.isNaN(eid)) {
            endpoint_id = eid;
            try {
              const ep = await endpointSvc.getEndpointById(eid);
              project_id = ep?.project_id ?? null;
            } catch (_) {}
          }
          await logSvc.insertLog({
            project_id,
            endpoint_id,
            endpoint_response_id: Number(it?.id) || null,
            request_method: req.method?.toUpperCase?.() || "PUT",
            request_path: urlPath,
            request_headers: headersReq,
            request_body: bodyReq,
            response_status_code: 400,
            response_body: { error: { message }, bad_item: it },
            ip_address: ip,
            latency_ms: 0,
          });
        } catch (_) {}
        return error(res, 400, message);
      }
    }
    const result = await svc.updatePriorities(
      req.db.stateless,
      items.map((it) => ({
        id: parseInt(it.id, 10),
        endpoint_id: parseInt(it.endpoint_id, 10),
        priority: parseInt(it.priority, 10),
      }))
    );

    // Ghi LOG: ghi theo DANH SÁCH ĐẦU VÀO để luôn có log kể cả khi không update được bản ghi nào
    // Mỗi phần tử trong payload → 1 dòng log tương ứng (array to many rows)
    try {
      const urlPath = req.originalUrl || req.path || "";
      const ip = getClientIp(req);
      const headersReq = req.headers || {};
      const bodyReq = req.body || {};
      const status = 200;

      // Tạo map kết quả theo id để gắn kèm vào log (nếu có)
      // Nếu không có bản ghi update tương ứng → responseBody sẽ có updated:false
      const resById = new Map();
      for (const r of result) {
        if (r && typeof r.id !== "undefined") resById.set(Number(r.id), r);
      }

      // Cache project_id theo endpoint_id để giảm query
      const projectCache = new Map();

      // Duyệt THEO items (payload đầu vào) để đảm bảo luôn có ghi log kể cả khi update 0 bản ghi
      const tasks = items.map(async (item) => {
        const endpoint_id = parseInt(item.endpoint_id, 10);
        let project_id = null;
        if (projectCache.has(endpoint_id)) {
          project_id = projectCache.get(endpoint_id);
        } else {
          try {
            const ep = await endpointSvc.getEndpointById(
              req.db.stateless,
              endpoint_id
            );
            project_id = ep?.project_id ?? null;
            projectCache.set(endpoint_id, project_id);
          } catch (_) {}
        }
        const updatedRow = resById.get(Number(item.id));
        const responseBody = updatedRow || {
          id: Number(item.id),
          endpoint_id: Number(item.endpoint_id),
          priority: Number(item.priority),
          updated: false,
        };

        await logSvc.insertLog({
          project_id,
          endpoint_id: isNaN(endpoint_id) ? null : endpoint_id,
          endpoint_response_id: Number(item.id),
          request_method: req.method?.toUpperCase?.() || "PUT",
          request_path: urlPath,
          request_headers: headersReq,
          request_body: bodyReq,
          response_status_code: status,
          response_body: responseBody,
          ip_address: ip,
          latency_ms: 0,
        });
      });
      // Chờ ghi log xong để đảm bảo dữ liệu có trong DB trước khi trả về
      const results = await Promise.allSettled(tasks);
      if (process.env.NODE_ENV !== "production") {
        const rejected = results.filter((r) => r.status === "rejected");
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        if (fulfilled.length > 0) {
          console.warn(
            `[updatePriorities] Logged ${fulfilled.length} records into project_request_logs`
          );
        }
        if (rejected.length > 0) {
          console.warn(
            "[updatePriorities] Some log records failed:",
            rejected.map((r) => r.reason?.message || r.reason)
          );
        }
      }
    } catch (_) {
      // Nuốt lỗi log để không ảnh hưởng API
    }

    return success(res, result);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [DELETE] /endpoint_responses/:id
// Xóa một response theo id
// - Trước khi xóa: NULL hoá FK endpoint_response_id trong project_request_logs để tránh lỗi ràng buộc
// - Sau khi xóa: GHI 1 DÒNG LOG cho action DELETE (endpoint_response_id = NULL để không dính FK)
async function remove(req, res) {
  const started = Date.now();
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, "id must be an integer");

    const urlPath = req.originalUrl || req.path || "";
    const ip = getClientIp(req);
    const headersReq = req.headers || {};
    const bodyReq = req.body || {};

    // Lấy thông tin trước khi xóa để SUY RA project_id, endpoint_id cho log
    let endpoint_id = null;
    let project_id = null;
    try {
      const existing = await svc.getById(req.db.stateless, rid);
      if (existing?.endpoint_id) {
        endpoint_id = existing.endpoint_id;
        try {
          const ep = await endpointSvc.getEndpointById(
            req.db.stateless,
            endpoint_id
          );
          project_id = ep?.project_id ?? null;
        } catch (_) {}
      }
    } catch (_) {}

    // Bước 1: NULL hoá tham chiếu trong bảng log để tránh FK
    try {
      if (rid) {
        await logSvc.nullifyEndpointResponseRef(rid);
      }
    } catch (_) {}

    // Bước 2: Xóa bản ghi endpoint_response
    await svc.remove(req.db.stateless, rid);

    const finished = Date.now();
    // Bước 3: Ghi 1 dòng log cho hành vi DELETE (endpoint_response_id = NULL để không bị FK)
    try {
      await logSvc.insertLog({
        project_id,
        endpoint_id,
        endpoint_response_id: null,
        request_method: "DELETE",
        request_path: urlPath,
        request_headers: headersReq,
        request_body: bodyReq,
        response_status_code: 200,
        response_body: { deleted_id: rid },
        ip_address: ip,
        latency_ms: finished - started,
      });
    } catch (_) {}

    return success(res, { deleted_id: rid });
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [PUT] /endpoint_responses/:id/set_default
// Đặt một response làm mặc định cho endpoint của nó
// - Service sẽ unset is_default tất cả response khác cùng endpoint
async function setDefault(req, res) {
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, "id must be an integer");

    const rows = await svc.setDefault(req.db.stateless, rid);
    return success(res, rows);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

module.exports = {
  listByEndpointQuery,
  getById,
  create,
  update,
  setDefault,
  updatePriorities,
  remove,
};
