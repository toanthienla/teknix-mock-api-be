const endpointResponseSvc = require("../services/endpoint_response.service");
const logSvc = require("../services/project_request_log.service");
const { pool } = require("../config/db");

function getClientIp(req) {
  const raw = (req.headers["x-forwarded-for"] || req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || "").toString();
  const first = raw.split(",")[0].trim();
  return first.substring(0, 45);
}

// Middleware bọc res.json/res.send để BẮT response trả về và GHI LOG vào project_request_logs
// scope: 'endpoint_responses' — middleware này biết cách SUY LUẬN id cho các route /endpoint_responses
// Lưu ý: Nếu bảng project_request_logs CHƯA TẠO, việc ghi log sẽ lỗi và bị nuốt (không ảnh hưởng response)
function adminResponseLogger(scope = "endpoint_responses") {
  return (req, res, next) => {
    // Chỉ log cho scope mong muốn; dựng full path kể cả khi có prefix (vd: /api)
    const urlPath = req.originalUrl || (req.baseUrl ? req.baseUrl + (req.path || "") : req.path || "") || "";
    if (scope === "endpoint_responses") {
      const inScope = urlPath.includes("/endpoint_responses");
      if (!inScope) return next();
      // Tránh GHI LOG TRÙNG cho route /endpoint_responses/priority
      // Vì controller updatePriorities đã tự ghi log N dòng (mỗi item 1 dòng)
      if (urlPath.includes("/endpoint_responses/priority")) {
        return next();
      }

      // BỎ QUA LOG cho các request LIST (GET) như:
      //   /endpoint_responses?endpoint_id=...
      // vì thường trả về mảng lớn → gây nhiễu log với N dòng.
      try {
        const method = (req.method || "").toUpperCase();
        const pathOnly = req.path || urlPath.split("?")[0] || ""; // path không gồm query
        const isListPath = /\/endpoint_responses\/?$/.test(pathOnly);
        const hasIdInPath = /\/endpoint_responses\/\d+(?:\/|$)/.test(pathOnly);
        const hasEndpointIdQuery = req.query && typeof req.query.endpoint_id !== "undefined" && `${req.query.endpoint_id}` !== "";
        if (method === "GET" && isListPath && !hasIdInPath && hasEndpointIdQuery) {
          return next(); // không gắn hook json/send → không ghi log
        }
      } catch (_) {
        /* noop */
      }
    }

    const started = Date.now();
    let logged = false;

    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);

    async function deriveMeta() {
      let endpoint_response_id = null;
      let endpoint_id = null;
      let project_id = null;

      try {
        // Prefer id from params for routes like /endpoint_responses/:id/... (e.g., set_default)
        let idParam = req.params?.id ? parseInt(req.params.id, 10) : null;
        // Nếu middleware đặt trước router nên req.params có thể trống: thử bắt id từ đường dẫn
        if (!idParam || Number.isNaN(idParam)) {
          const m = (urlPath || "").match(/\/endpoint_responses\/(\d+)(?:\b|\/|\?|#|$)/);
          if (m && m[1]) {
            idParam = parseInt(m[1], 10);
          }
        }
        if (idParam && !Number.isNaN(idParam)) {
          endpoint_response_id = idParam;
          const er = await endpointResponseSvc.getById(idParam);
          if (er?.endpoint_id) {
            endpoint_id = er.endpoint_id;
            const ep = await endpointSvc.getEndpointById(pool, endpoint_id);
            project_id = ep?.project_id ?? null;
          }
        } else if (req.query?.endpoint_id) {
          const eid = parseInt(req.query.endpoint_id, 10);
          if (!Number.isNaN(eid)) {
            endpoint_id = eid;
            const ep = await endpointSvc.getEndpointById(pool, endpoint_id);
            project_id = ep?.project_id ?? null;
          }
        }
      } catch (_) {}

      return { endpoint_response_id, endpoint_id, project_id };
    }

    async function writeLog(payload) {
      if (logged) return;
      logged = true;
      const finished = Date.now();
      try {
        const baseMeta = await deriveMeta();
        const { project_id: baseProjectId, endpoint_id: baseEndpointId, endpoint_response_id: baseEndpointResponseId } = baseMeta;
        const bodyReq = req.body || {};
        const headersReq = req.headers || {};
        const status = res.statusCode || 200;
        const ip = getClientIp(req);

        // Ensure response_body is JSON-friendly object/array (JSONB)
        let response_body = payload;
        if (typeof response_body === "string") {
          try {
            response_body = JSON.parse(response_body);
          } catch {
            response_body = { text: response_body };
          }
        }

        // Hàm chèn 1 bản ghi log đơn lẻ
        const insertOne = async ({ project_id, endpoint_id, endpoint_response_id, response_body: rb }) => {
          await logSvc.insertLog(req.db?.stateless || pool, {
            project_id: project_id || null,
            endpoint_id: endpoint_id || null,
            endpoint_response_id: endpoint_response_id || null,
            request_method: req.method?.toUpperCase?.() || "",
            request_path: urlPath,
            request_headers: headersReq,
            request_body: bodyReq,
            response_status_code: status,
            response_body: rb ?? {},
            ip_address: ip,
            latency_ms: finished - started,
          });
        };

        // Nếu response là MẢNG → ghi N DÒNG, mỗi phần tử 1 dòng
        if (Array.isArray(response_body)) {
          // Cache project_id theo endpoint_id để tránh query lặp
          const projectCache = new Map(); // endpoint_id -> project_id
          const tasks = response_body.map(async (item) => {
            // item có thể là object hoặc primitive
            let perERId = item && typeof item === "object" ? item.id ?? baseEndpointResponseId : baseEndpointResponseId;
            let perEndpointId = item && typeof item === "object" ? item.endpoint_id ?? baseEndpointId : baseEndpointId;
            let perProjectId = baseProjectId;

            // Nếu chưa có project_id mà có endpoint_id → tra cứu để điền project_id
            if (!perProjectId && perEndpointId) {
              if (projectCache.has(perEndpointId)) {
                perProjectId = projectCache.get(perEndpointId);
              } else {
                try {
                  const ep = await endpointSvc.getEndpointById(pool, perEndpointId);
                  perProjectId = ep?.project_id ?? null;
                  projectCache.set(perEndpointId, perProjectId);
                } catch {
                  // bỏ qua lỗi
                }
              }
            }

            const rb = item && typeof item === "object" ? item : { value: item };
            await insertOne({ project_id: perProjectId, endpoint_id: perEndpointId, endpoint_response_id: perERId, response_body: rb });
          });
          await Promise.all(tasks);
        } else {
          // Mặc định: ghi 1 dòng cho object/thường
          await insertOne({ project_id: baseProjectId, endpoint_id: baseEndpointId, endpoint_response_id: baseEndpointResponseId, response_body });
        }
        // ============================
        // 🔔 BƯỚC 3: WebSocket publish được xử lý bởi project_request_log.service.insertLog()
        // thông qua maybePublishWsOnLog() → không publish ở đây để tránh duplicate
        // ============================
      } catch (e) {
        // Không chặn response khi ghi log lỗi; in cảnh báo ở môi trường dev để dễ debug
        if (process.env.NODE_ENV !== "production") {
          console.warn("[adminResponseLogger] Ghi log thất bại:", e?.message || e);
        }
      }
    }

    res.json = function jsonHook(data) {
      try {
        // Schedule log but do not block response
        Promise.resolve().then(() => writeLog(data));
      } catch (_) {}
      return origJson(data);
    };

    res.send = function sendHook(body) {
      try {
        Promise.resolve().then(() => writeLog(body));
      } catch (_) {}
      return origSend(body);
    };

    return next();
  };
}

module.exports = adminResponseLogger;
