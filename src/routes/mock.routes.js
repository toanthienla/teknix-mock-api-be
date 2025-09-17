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
const db = require("../config/db");
const { match } = require("path-to-regexp");
const router = express.Router();

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
    const method = req.method.toUpperCase();

    // 1) Lấy danh sách endpoint theo method hiện tại
    const { rows: endpoints } = await db.query(
      `SELECT e.id, e.method, e.path,
              EXISTS (SELECT 1 FROM endpoint_responses r WHERE r.endpoint_id = e.id) AS has_response,
              EXISTS (SELECT 1 FROM endpoint_responses r WHERE r.endpoint_id = e.id AND r.is_default = true) AS has_default
       FROM endpoints e
       WHERE UPPER(e.method) = $1
       ORDER BY has_default DESC, has_response DESC, e.id DESC`,
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

    // 3) Lấy toàn bộ responses của endpoint để có thể áp dụng điều kiện theo params/query
    const matchFn = getMatcher(ep.path);
    const matchRes = matchFn(req.path);
    const params = (matchRes && matchRes.params) || {};
    const hasParams = Object.keys(params).length > 0;

    const { rows: responses } = await db.query(
      `SELECT id, endpoint_id, name, status_code, response_body,
       is_default, priority, condition, delay_ms,
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
      if (req.method.toUpperCase() === "GET") {
        return res.status(200).json(hasParams ? {} : []);
      }
      return res.status(501).json({
        error: { message: "No response configured for this endpoint" },
      });
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
    return res.status(404).json({ error: "No matching response found" });
  }
    }

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
    setTimeout(() => {
      if (body && typeof body === "object") {
        return res.status(status).json(body);
      }
      return res.status(status).send(body ?? "");
    }, delay);

    // // Trả đúng response_body đã cấu hình: nếu là object => JSON, còn lại => text
    // if (body && typeof body === "object") return res.status(status).json(body);
    // return res.status(status).send(body ?? "");
  } catch (err) {
    // Cho middleware xử lý lỗi chung xử lý tiếp
    return next(err);
  }
});

module.exports = router;
