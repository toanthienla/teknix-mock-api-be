const endpointResponseSvc = require("../services/endpoint_response.service");
const endpointSvc = require("../services/endpoint.service");
const logSvc = require("../services/project_request_log.service");
const { render } = require("../utils/wsTemplate");
const { pool } = require("../config/db");
// ws-manager nằm ở thư mục gốc WS; broadcast sẽ được gán khi initWs() chạy lúc khởi động server
const wsMgr = require("../utils/ws-manager");
const { match } = require("path-to-regexp");

// Fallback: resolve endpoint_id từ URL nếu chưa có (dùng meta universal + baseUrl)
async function resolveEndpointIdByUrl(req) {
  try {
    const method = (req.method || "").toUpperCase();

    // 1) Ưu tiên meta có sẵn từ universal
    const u = req.universal || {};
    let ws = u.workspaceName || req.params?.workspace;
    let pj = u.projectName || req.params?.project;
    let restPath = u.subPath; // đã là "/<...>" sau prefix
    let projectId = u.projectId || null;

    // 2) Nếu thiếu, suy ra từ baseUrl + path
    if (!ws || !pj) {
      const segs = String(req.baseUrl || "")
        .split("/")
        .filter(Boolean); // "/WP_2/pj3"
      ws = ws || segs[0];
      pj = pj || segs[1];
    }
    if (!restPath) {
      const full = req.baseUrl ? req.baseUrl + (req.path || "") : req.originalUrl || req.path || "";
      const onlyPath = full.split("?")[0];
      // cắt prefix "/:ws/:pj"
      const prefix = `/${ws}/${pj}`;
      restPath = onlyPath.startsWith(prefix) ? onlyPath.slice(prefix.length) || "/" : onlyPath;
    }

    // 3) projectId — nếu chưa có thì JOIN theo tên
    if (!projectId && ws && pj) {
      const { rows: prj } = await pool.query(
        `SELECT p.id
           FROM projects p
           JOIN workspaces w ON w.id = p.workspace_id
         WHERE w.name = $1 AND p.name = $2
          LIMIT 1`,
        [ws, pj]
      );
      projectId = prj?.[0]?.id || null;
    }
    if (!projectId) return null;

    // 4) lấy các endpoint của project + method
    const { rows: eps } = await pool.query(
      `SELECT e.id, e.path
         FROM endpoints e
         JOIN folders f ON f.id = e.folder_id
        WHERE UPPER(e.method) = $1
       AND f.project_id = $2`,
      [method, projectId]
    );

    // 5) match pattern (params/wildcard) bằng path-to-regexp
    for (const e of eps) {
      const pat = String(e.path || "/");
      const hasParams = pat.includes(":") || pat.includes("*");
      const fn = match(pat, { decode: decodeURIComponent, end: true, strict: false });
      if (hasParams ? Boolean(fn(restPath)) : pat === restPath) {
        return e.id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

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
        // 🔔 BƯỚC 3: quyết định broadcast WS
        // ============================
        try {
          // Chỉ broadcast khi xác định được endpoint_id
          let endpointId = baseEndpointId;
          if (!endpointId) {
            endpointId = await resolveEndpointIdByUrl(req); // Fallback cho universal handler
          }
          if (!endpointId) return;

          // Lấy endpoint (bao gồm websocket_config) và project_id
          // Service mới cần truyền dbPool
          const ep = await endpointSvc.getEndpointById(pool, endpointId);
          if (!ep) return;
          const cfg = ep.websocket_config || {};
          // Điều kiện: bật + status khớp
          if (!cfg.enabled || !(Number.isInteger(cfg.condition) && cfg.condition === status)) return;

          // Truy ra workspace/project name theo endpoint_id (JOIN folders→projects→workspaces)
          const q = `
            SELECT w.name AS workspace, p.name AS project
            FROM endpoints e
            JOIN folders f   ON f.id = e.folder_id
            JOIN projects p  ON p.id = f.project_id
            JOIN workspaces w ON w.id = p.workspace_id
            WHERE e.id = $1
            LIMIT 1
          `;
          const { rows } = await pool.query(q, [endpointId]);
          if (!rows.length) return;
          const { workspace, project } = rows[0];

          // Chuẩn bị context & message
          const ctx = {
            request: {
              method: (req.method || "").toUpperCase(),
              path: req.originalUrl || req.path || "",
              headers: headersReq,
              body: bodyReq,
              query: req.query || {}, // <-- thêm query để dùng {{request.query.*}} trong template
            },
            response: {
              status_code: status,
              body: response_body,
            },
          };
          const message = cfg.message == null ? `${ctx.request.method} ${ctx.request.path} → ${status}` : render(String(cfg.message), ctx);

          // >>> THÊM LOG NGAY TRƯỚC KHI TẠO `data` <<<
          // console.log("[WS] endpointId resolved =", endpointId, "status =", status);
          // console.log("[WS] cfg =", cfg);
          // console.log("[WS] channel =", `${workspace}/${project}`, "message =", message);
          const data = {
            type: "endpoint_ws_message",
            channel: `${workspace}/${project}`,
            endpoint_id: endpointId,
            status_code: status,
            message,
            at: Date.now(),
          };

          // Gửi sau delay_ms (nếu có)
          const delay = Number.isInteger(cfg.delay_ms) && cfg.delay_ms > 0 ? cfg.delay_ms : 0;
          const doSend = () => {
            if (typeof wsMgr.broadcast === "function") {
              try {
                wsMgr.broadcast({ workspace, project, data });
              } catch (_) {}
            }
          };
          delay ? setTimeout(doSend, delay) : doSend();
        } catch (err) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[adminResponseLogger] WS broadcast failed:", err?.message || err);
          }
        }
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
