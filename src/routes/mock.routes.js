// Mock runtime router
// ------------------------------------------------------------
// Mục đích: Bắt tất cả request còn lại (sau các route quản trị)
// và trả về dữ liệu mô phỏng từ DB theo bảng endpoints + endpoint_responses.
//
// Luồng xử lý tổng quát:
// 1) Lấy HTTP method hiện tại (GET/POST/PUT/DELETE,...)
// 2) Query tất cả endpoint có method tương ứng từ bảng endpoints
// 3) Dùng path-to-regexp để so khớp pattern endpoint.path với req.path
//    - Hỗ trợ dynamic params: ví dụ '/users/:id'
//    - strict: true, end: true => khớp chính xác (nhạy cảm dấu '/')
// 4) Nếu tìm thấy endpoint phù hợp, lấy endpoint_responses tương ứng
//    và chọn 1 response để trả về (ưu tiên condition match > is_default > mới nhất)
// 5) Trả về body (JSON nếu là object, còn lại send text)
//

const express = require("express");
//const db = require("../config/db");
const { match } = require("path-to-regexp");
// Service ghi log request/response vào bảng project_request_logs
const router = express.Router();
const axios = require("axios");
const https = require("https");

const { logRequest } = require("../services/log.service");
const endpointService = require("../services/endpoint.service");
const endpointResponseService = require("../services/endpoint_response.service");
const logSvc = require("../services/project_request_log.service");
// Bộ so khớp path-to-regexp có cache đơn giản để tránh tạo lại matcher nhiều lần
// key: pattern string, value: match function
const matcherCache = new Map();

/**
 * Tạo/đọc matcher cho 1 pattern endpoint.path
 * Ví dụ pattern: '/users/:id' sẽ khớp '/users/42'
 * - strict: true => phân biệt có/không có dấu '/' ở cuối
 * - end: true => phải khớp toàn bộ path (không cho phép phần dư)
 */
function getMatcher(pattern) {
  // Tạo matcher path-to-regexp cho từng endpoint.path, có cache
  let fn = matcherCache.get(pattern);
  if (!fn) {
    fn = match(pattern, {
      decode: decodeURIComponent,
      strict: true,
      end: true,
    });
    matcherCache.set(pattern, fn);
  }
  return fn;
}

function getClientIp(req) {
  const raw = (
    req.headers["x-forwarded-for"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip ||
    ""
  ).toString();
  const first = raw.split(",")[0].trim();
  return first.substring(0, 45);
}

// ------------------------------------------------------------
// Templating đơn giản cho response_body: hỗ trợ {{params.id}}, {{query.id}}
// Có thể mở rộng thêm: {{headers.x_token}}, {{body.foo}} nếu cần sau này
function getByPath(obj, path) {
  if (!obj || typeof path !== "string") return undefined;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, p)) {
      cur = cur[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function renderTemplate(value, ctx) {
  const replaceInString = (str) =>
    str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, vpath) => {
      const v = getByPath(ctx, vpath);
      return v == null ? "" : String(v);
    });

  if (typeof value === "string") return replaceInString(value);
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (value && typeof value === "object") {
    const out = Array.isArray(value) ? [] : {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderTemplate(v, ctx);
    }
    return out;
  }
  return value;
}

// Catch-all sau các route admin; tìm endpoint tương ứng và trả mock response từ DB
// Đặt router.use ở cuối app để không “nuốt” các route quản trị phía trên.

router.use(async (req, res, next) => {
  try {
    const started = Date.now();
    const method = req.method.toUpperCase();

    // Kiểm tra xem request có /proxy prefix hay không
    let originalPath = req.path;
    let isProxyRequest = false;
    if (originalPath.startsWith("/proxy/")) {
      isProxyRequest = true;
      req.path = originalPath.replace(/^\/proxy/, ""); // bỏ prefix để match endpoint
    }

    // 1) Lấy danh sách endpoint theo method hiện tại
    const { rows: endpoints } = await req.db.stateless.query(
      `SELECT id, method, path, folder_id, is_stateful
       FROM endpoints
       WHERE UPPER(method) = $1 AND is_active = true`,
      [method]
    );

    // 2) Chọn endpoint đầu tiên có path khớp req.path
    //    Lưu ý: nếu có nhiều endpoint trùng method + path, endpoint có id cao hơn (mới hơn)
    //    sẽ được duyệt trước do ORDER BY id DESC.
    const ep = endpoints.find((e) => {
      try {
        const fn = getMatcher(e.path);
        return Boolean(fn(req.path));
      } catch (_) {
        return false;
      }
    });
    if (!ep) return next();

    if (ep.is_stateful) {
      // ==========================================================
      // LOGIC CHO ENDPOINT STATEFUL
      // ==========================================================
      console.log(`--> Endpoint ID ${ep.id} là STATEFUL. Path: ${ep.path}`);

      // Truy vấn DB stateful để lấy dữ liệu
      const { rows: dataRows } = await req.db.stateful.query(
        // <-- SỬ DỤNG req.db.stateful
        "SELECT data_current FROM endpoint_data WHERE path = $1",
        [ep.path]
      );

      if (dataRows.length === 0) {
        return res
          .status(404)
          .json({ error: `Stateful data for path '${ep.path}' not found.` });
      }

      const responseBody = dataRows[0].data_current;
      return res.status(200).json(responseBody);
    } else {
      // 3) Lấy toàn bộ responses của endpoint để có thể áp dụng điều kiện theo params/query
      const matchFn = getMatcher(ep.path);
      const matchRes = matchFn(req.path);
      const params = (matchRes && matchRes.params) || {};
      const hasParams = Object.keys(params).length > 0;

      const { rows: responses } = await req.db.stateless.query(
        `SELECT id, endpoint_id, name, status_code, response_body,
       is_default, priority, condition, delay_ms,
       proxy_url, proxy_method, 
       created_at, updated_at
  FROM endpoint_responses
  WHERE endpoint_id = $1
  ORDER BY is_default DESC, priority ASC NULLS LAST, updated_at DESC, created_at DESC
  `,
        [ep.id]
      );

      // Nếu không có response nào cấu hình:
      // - GET item (có params): trả {} (rỗng)
      // - GET collection: trả [] (rỗng)
      if (responses.length === 0) {
        // No configured responses for this endpoint
        // For GET: return empty object/array (legacy behavior)
        const status = req.method.toUpperCase() === "GET" ? 200 : 501;
        const body =
          req.method.toUpperCase() === "GET"
            ? hasParams
              ? {}
              : []
            : {
                error: { message: "No response configured for this endpoint" },
              };
        const finished = Date.now();
        // Ghi log cho trường hợp endpoint KHÔNG có response cấu hình
        try {
          const ip = getClientIp(req);
          await logRequest(req.db.stateless, {
            folderId: ep.folder_id || null,
            endpointId: ep.id,
            endpointResponseId: null,
            method,
            path: req.path,
            headers: req.headers || {},
            body: req.body || {},
            statusCode: status,
            responseBody: body,
            ip,
            latencyMs: finished - started,
          });
        } catch (e) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              "[mock.routes] Ghi log (no responses) thất bại:",
              e?.message || e
            );
          }
        }

        if (req.method.toUpperCase() === "GET") {
          return res.status(status).json(body);
        } else {
          return res.status(status).json(body);
        }
      }

      // 3.1) Áp dụng điều kiện: ưu tiên các response có condition khớp params/query
      const isPlainObject = (v) =>
        v && typeof v === "object" && !Array.isArray(v);
      const matchesCondition = (cond) => {
        if (!isPlainObject(cond) || Object.keys(cond).length === 0) {
          return false; // condition rỗng thì KHÔNG match
        }

        // Check params.id đơn giản
        if ("id" in cond) {
          if (String(params.id ?? "") !== String(cond.id)) return false;
        }
        // Check params object
        if (isPlainObject(cond.params)) {
          for (const [k, v] of Object.entries(cond.params)) {
            if (String(params[k] ?? "") !== String(v)) return false;
          }
        }

        // Check query object
        if (isPlainObject(cond.query)) {
          for (const [k, v] of Object.entries(cond.query)) {
            if (String(req.query[k] ?? "") !== String(v)) return false;
          }
        }

        // Check headers object
        if (isPlainObject(cond.headers)) {
          for (const [k, v] of Object.entries(cond.headers)) {
            const reqVal = req.headers[k.toLowerCase()]; // headers luôn lowercase
            if (String(reqVal ?? "") !== String(v)) return false;
          }
        }

        // Check body object
        if (isPlainObject(cond.body)) {
          for (const [k, v] of Object.entries(cond.body)) {
            if (String(req.body?.[k] ?? "") !== String(v)) return false;
          }
        }

        // Có thể mở rộng cho cond.headers/cond.body nếu cần
        return true;
      };

      // 3.2) Lọc toàn bộ response có condition khớp
      const matchedResponses = responses.filter((r) =>
        matchesCondition(r.condition)
      );

      let r;
      if (matchedResponses.length > 0) {
        // Sắp xếp theo priority ASC (1 là cao nhất), rồi updated_at DESC
        matchedResponses.sort((a, b) => {
          const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
          const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
          if (pa !== pb) return pa - pb; // số nhỏ hơn ưu tiên hơn
          return new Date(b.updated_at) - new Date(a.updated_at);
        });
        r = matchedResponses[0];
      } else {
        // Nếu không có match và cũng không có default → trả 404
        r = responses.find((rr) => rr.is_default);
        if (!r) {
          const status = 404;
          const body = { error: "No matching response found" };
          const finished = Date.now();
          try {
            const ip = getClientIp(req);
            await logRequest(req.db.stateless, {
              folderId: ep.folder_id || null,
              endpointId: ep.id,
              endpointResponseId: null,
              method,
              path: req.path,
              headers: req.headers || {},
              body: req.body || {},
              statusCode: status,
              responseBody: body,
              ip,
              latencyMs: finished - started,
            });
          } catch (e) {
            if (process.env.NODE_ENV !== "production") {
              console.warn(
                "[mock.routes] Ghi log (404 no match) thất bại:",
                e?.message || e
              );
            }
          }
          return res.status(status).json(body);
        }
      }

      // 3.3) Nếu có proxy_url → gọi API ngoài (proxy) thay vì trả response_body
      if (r.proxy_url) {
        try {
          const ctx = { params, query: req.query };
          const resolvedUrl = renderTemplate(r.proxy_url, ctx);
          console.log("[Proxy] resolvedUrl =", resolvedUrl);

          // Gọi API ngoài với httpsAgent để bỏ qua verify SSL
          const proxyResp = await axios({
            method: r.proxy_method || req.method,
            url: resolvedUrl,
            data: req.body,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept: "application/json, text/plain, */*",
              "Accept-Language": "en-US,en;q=0.9",
              Referer: "https://jsonplaceholder.typicode.com/",
            },
            validateStatus: () => true,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
          });
          // Ghi log response từ proxy
          const finished = Date.now();
          try {
            const ip = getClientIp(req);
            await logRequest(req.db.stateless, {
              folderId: ep.folder_id || null,
              endpointId: ep.id,
              endpointResponseId: r.id || null,
              method,
              path: req.path,
              headers: req.headers || {},
              body: req.body || {},
              statusCode: proxyResp.status,
              responseBody: proxyResp.data,
              ip,
              latencyMs: finished - started,
            });
          } catch (_) {}

          return res
            .status(proxyResp.status)
            .set(proxyResp.headers)
            .send(proxyResp.data);
        } catch (err) {
          console.error("[mock.routes] Proxy request failed:", err.message);
          return res.status(502).json({ error: "Bad Gateway (proxy failed)" });
        }
      }
      // Nếu không proxy thì tiếp tục trả response_body bên dưới
      // 4) Trả về nội dung response:
      // - Nếu response_body là object => trả JSON
      // - Nếu là string/empty => send text/empty string
      const status = r.status_code || 200;
      let body = r.response_body ?? null;

      // Templating: thay thế {{params.*}} và {{query.*}} trong body (string hoặc object)
      const ctx = { params, query: req.query };
      if (body && (typeof body === "object" || typeof body === "string")) {
        body = renderTemplate(body, ctx);
      }

      // Chuẩn hoá cho GET collection (không có params): nếu body rỗng => trả []
      if (req.method.toUpperCase() === "GET" && !hasParams) {
        const isEmptyObject = (v) =>
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          Object.keys(v).length === 0;
        if (
          body == null ||
          (typeof body === "string" && body.trim() === "") ||
          isEmptyObject(body)
        ) {
          body = [];
        }
      }

      //  Áp dụng delay_ms
      const delay = r.delay_ms ?? 0;

      const sendResponse = async () => {
        const finished = Date.now();
        // Ghi log request/response (có endpoint_response_id)
        try {
          const ip = getClientIp(req);
          await logSvc.insertLog(req.db.stateless, {
            folder_id: ep.folder_id || null,
            endpoint_id: ep.id,
            endpoint_response_id: r.id || null,
            request_method: method, // <-- Đã sửa
            request_path: req.path, // <-- Đã sửa
            request_headers: req.headers || {}, // <-- Đã sửa
            request_body: req.body || {}, // <-- Đã sửa
            response_status_code: status, // <-- Đã sửa
            response_body: body, // <-- Đã sửa
            ip_address: ip, // <-- Đã sửa
          });
        } catch (e) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              "[mock.routes] Ghi log (matched response) thất bại:",
              e?.message || e
            );
          }
        }

        if (body && typeof body === "object") {
          return res.status(status).json(body);
        }
        return res.status(status).send(body ?? "");
      };

      if (delay > 0) {
        setTimeout(() => {
          sendResponse();
        }, delay);
      } else {
        await sendResponse();
      }
    }
    // // Trả đúng response_body đã cấu hình: nếu là object => JSON, còn lại => text
    // if (body && typeof body === "object") return res.status(status).json(body);
    // return res.status(status).send(body ?? "");
  } catch (err) {
    // Lỗi bất ngờ: cố gắng ghi log 500
    try {
      const started = Date.now();
      const ip = getClientIp(req);
      await logRequest(req.db.stateless, {
        folderId: null,
        endpointId: null,
        endpointResponseId: null,
        method: req.method?.toUpperCase?.() || "",
        path: req.path || req.originalUrl || "",
        headers: req.headers || {},
        body: req.body || {},
        statusCode: 500,
        responseBody: { error: "Internal Server Error" },
        ip,
        latencyMs: 0,
      });
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[mock.routes] Ghi log (unexpected error) thất bại:",
          e?.message || e
        );
      }
    }
    // Cho middleware xử lý lỗi chung xử lý tiếp
    return next(err);
  }
});

module.exports = router;
