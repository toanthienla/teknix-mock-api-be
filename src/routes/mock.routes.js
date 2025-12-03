const express = require("express");
const { match } = require("path-to-regexp");
const router = express.Router();
const axios = require("axios");
const https = require("https");
const logSvc = require("../services/project_request_log.service");
const { getCollection } = require("../config/db");
const FormData = require("form-data");
const cloudscraper = require("cloudscraper");
const os = require("os");

// === NEW: sanitize headers (both directions)
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function sanitizeForwardHeaders(h) {
  const out = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "host") continue;
    if (key === "content-length") continue;
    if (key === "content-encoding") continue; // tránh mismatch decompress
    if (key === "accept-encoding") continue; // tránh CF/chuẩn hoá
    // Không forward header nội bộ dùng để điều khiển proxy
    if (key === "x-proxy-authorization") continue;
    if (key === "x-proxy-auth-profile") continue;
    out[k] = v;
  }
  return out;
}
function sanitizeResponseHeaders(h) {
  const out = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "content-encoding") continue; // body đã được axios giải nén
    if (key === "transfer-encoding") continue;
    if (key === "content-length") continue; // để Node tự set lại
    out[k] = v;
  }
  return out;
}
// === NEW: Authorization override (từ header nội bộ hoặc env profile)
function resolveAuthOverride(req) {
  const h = req.headers || {};
  if (h["x-proxy-authorization"]) return String(h["x-proxy-authorization"]);
  const profile = h["x-proxy-auth-profile"];
  if (profile) {
    const envKey = `PROXY_AUTH_${String(profile).toUpperCase()}`;
    if (process.env[envKey]) return process.env[envKey];
  }
  return null;
}

// === ADD: helper lấy danh sách id từ request theo thứ tự ưu tiên
const pickIdsFromReq = (req) => {
  const ids = [];

  // query & params
  if (req.query?.id != null) ids.push(String(req.query.id));
  if (req.params?.id != null) ids.push(String(req.params.id));

  // headers (whitelist)
  const headerKeys = ["x-id", "x-resource-id", "x-user-id"];
  for (const h of headerKeys) {
    const v = req.headers?.[h];
    if (v != null) ids.push(String(v));
  }

  // body
  if (req.body && typeof req.body === "object") {
    if (req.body.id != null) ids.push(String(req.body.id));
    if (req.body.userId != null) ids.push(String(req.body.userId));
  }

  // unique theo thứ tự
  return [...new Set(ids)];
};

// === ADD: helper lấy endpoints_ful.id từ origin_id (endpoints.id)
async function getEndpointsFulId(statefulPool, originId) {
  const { rows } = await statefulPool.query(`SELECT id FROM endpoints_ful WHERE origin_id = $1 LIMIT 1`, [originId]);
  return rows?.[0]?.id ?? null;
}

// === ADD: helper lấy response template (Not Found / Schema Invalid / ID Conflict...)
async function getTemplateResponse(statefulPool, epFulId, name, fallback) {
  if (!epFulId) return fallback;
  const { rows } = await statefulPool.query(
    `SELECT status_code, response_body
     FROM endpoint_responses_ful
     WHERE endpoint_id = $1 AND name = $2
     ORDER BY updated_at DESC
     LIMIT 1`,
    [epFulId, name]
  );
  if (rows?.[0]) return rows[0];
  return fallback;
}
// === END ADD

async function getSafeUserId(req) {
  try {
    // 🔄 ƯU TIÊN: Header mockhub-user-id > JWT token
    // Thay đổi: Lấy trực tiếp từ header thay vì JWT token
    
    // 1. Thử lấy từ header trước (case-insensitive)
    const headerUserId = 
      req.headers?.["mockhub-user-id"] ?? 
      req.headers?.["Mockhub-User-Id"] ??
      req.headers?.["MOCKHUB-USER-ID"];
    
    if (headerUserId != null) {
      const idNum = Number(headerUserId);
      if (Number.isInteger(idNum) && idNum > 0) {
        return idNum;
      }
    }
    
    // 2. Fallback: Lấy từ JWT token (req.user)
    const raw = req.user && req.user.id != null ? req.user.id : null;
    const idNum = Number(raw);
    
    // Chỉ return nếu là number hợp lệ > 0
    if (!Number.isInteger(idNum) || idNum <= 0) return null;
    return idNum;
  } catch (e) {
    return null;
  }
}

// ✅ Helper: Validate user_id và trả về null nếu không tồn tại trong DB
async function validateUserIdForLog(req, userId) {
  if (userId == null) return null;
  
  try {
    const userCheck = await req.db.stateless.query("SELECT id FROM users WHERE id = $1 LIMIT 1", [userId]);
    if (userCheck.rows.length === 0) {
      console.log(`[mock.routes] user_id ${userId} not found in DB, logging with null`);
      return null;
    }
    return userId;
  } catch (e) {
    console.error("[mock.routes] error validating user_id:", e?.message || e);
    return null;
  }
}
// --- Match helpers: hỗ trợ match “sâu” cho pattern không có param/wildcard
const matcherCache = new Map();
function getMatcher(pattern, end = true) {
  const key = `${pattern}__end=${end ? 1 : 0}`;
  let fn = matcherCache.get(key);
  if (!fn) {
    fn = match(pattern, { decode: decodeURIComponent, strict: false, end });
    matcherCache.set(key, fn);
  }
  return fn;
}

function buildLoosePatternIfNeeded(pattern) {
  // Nếu KHÔNG có ":" hoặc "*" thì tự mở rộng để match sâu: "/a/b" => "/a/b/:rest(.*)?"
  if (!pattern.includes(":") && !pattern.includes("*")) {
    return pattern.endsWith("/") ? `${pattern}:rest(.*)?` : `${pattern}/:rest(.*)?`;
  }
  return pattern;
}

// 🔥 Độ "cụ thể" của path: nhiều segment hơn, nhiều segment tĩnh hơn, ít dynamic hơn
function computeSpecificity(path) {
  if (!path || typeof path !== "string") {
    return { segments: 0, staticSegs: 0, dynamicSegs: 0 };
  }
  const parts = path.split("/").filter(Boolean);
  let staticSegs = 0;
  let dynamicSegs = 0;

  for (const p of parts) {
    if (p.startsWith(":") || p.includes("*")) {
      dynamicSegs++;
    } else {
      staticSegs++;
    }
  }

  return {
    segments: parts.length,
    staticSegs,
    dynamicSegs,
  };
}

function getClientIp(req) {
  const raw = (req.headers["x-forwarded-for"] || req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || "").toString();
  const first = raw.split(",")[0].trim();
  return first.substring(0, 45);
}

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

router.use(async (req, res, next) => {
  const started = Date.now();
  const safeUserId = await getSafeUserId(req);
  try {
    // 🚦 CHỈ bỏ qua khi KHÔNG đi qua universal
    const rawPath = req.path || req.originalUrl || "";
    if (!req.universal && /^\/[^/]+\/[^/]+(?:\/|$)/.test(rawPath)) {
      // Trường hợp gọi trực tiếp ở app (không qua universal) → nhường cho universal
      return next();
    }
    const method = req.method.toUpperCase();

    // Chuẩn hoá pathForMatch:
    // - Nếu đi qua universal → dùng subPath mà universal đã cắt sẵn
    // - Ngược lại → dùng req.path như legacy
    const pathForMatch = req.universal?.subPath || req.path || "";

    const { rows: endpoints } = await req.db.stateless.query(
      `SELECT e.id, e.method, e.path, e.folder_id, e.is_stateful, e.is_active, f.project_id, f.is_public
    FROM endpoints e
    LEFT JOIN folders f ON e.folder_id = f.id
    WHERE UPPER(e.method) = $1`,
      [method]
    );

    // Tập ứng viên khớp path (dùng subPath nếu có)
    let matches = endpoints.filter((e) => {
      try {
        // Với pattern không có param/wildcard → cho phép match sâu
        const hasParams = e.path.includes(":") || e.path.includes("*");
        const pat = hasParams ? e.path : buildLoosePatternIfNeeded(e.path);
        const fn = getMatcher(pat, hasParams /* end=true nếu có param; ngược lại đã có :rest */);
        return Boolean(fn(pathForMatch));
      } catch (_) {
        return false;
      }
    });

    // Fallback: thử thêm/bớt dấu "/" cuối cho pathForMatch
    if (matches.length === 0) {
      const altPath = pathForMatch.endsWith("/") ? pathForMatch.slice(0, -1) : pathForMatch + "/";
      matches = endpoints.filter((e) => {
        try {
          const hasParams = e.path.includes(":") || e.path.includes("*");
          const pat = hasParams ? e.path : buildLoosePatternIfNeeded(e.path);
          const fn = getMatcher(pat, hasParams);
          return Boolean(fn(altPath));
        } catch (_) {
          return false;
        }
      });
    }

    // Ưu tiên endpoint đúng project + đúng statelessId từ universal (nếu có),
    // nếu không thì chọn ứng viên "cụ thể" nhất:
    let ep = null;
    if (matches.length > 0) {
      // 1) Nếu universal đã chọn sẵn statelessId thì dùng lại đúng endpoint đó
      if (req.universal && req.universal.statelessId) {
        ep = matches.find((e) => e.id === req.universal.statelessId) || null;
      }

      // 2) Nếu chưa chọn được, lọc theo projectId (nếu có)
      let candidates = matches;
      if (!ep && req.universal && req.universal.projectId) {
        const byProject = matches.filter((e) => e.project_id === req.universal.projectId);
        if (byProject.length > 0) {
          candidates = byProject;
        }
      }

      if (!ep) {
        // Lấy danh sách id để kiểm tra có response hay không
        const ids = candidates.map((m) => m.id);
        const { rows: respCounts } = await req.db.stateless.query(
          `SELECT endpoint_id, COUNT(*)::int AS cnt
             FROM endpoint_responses
            WHERE endpoint_id = ANY($1)
            GROUP BY endpoint_id`,
          [ids]
        );
        const countMap = new Map(respCounts.map((r) => [Number(r.endpoint_id), Number(r.cnt)]));

        // xếp hạng: PATH CỤ THỂ HƠN > stateless > active > có response
        candidates.sort((a, b) => {
          // Ưu tiên path cụ thể hơn
          const specA = computeSpecificity(a.path);
          const specB = computeSpecificity(b.path);

          // 1) nhiều segment hơn trước (/groups/:id/queue > /groups)
          if (specA.segments !== specB.segments) {
            return specB.segments - specA.segments;
          }

          // 2) nhiều segment tĩnh hơn trước
          if (specA.staticSegs !== specB.staticSegs) {
            return specB.staticSegs - specA.staticSegs;
          }

          // 3) ít segment dynamic hơn trước
          if (specA.dynamicSegs !== specB.dynamicSegs) {
            return specA.dynamicSegs - specB.dynamicSegs;
          }

          // 4) stateless (0) trước stateful (1)
          const sa = a.is_stateful ? 1 : 0;
          const sb = b.is_stateful ? 1 : 0;
          if (sa !== sb) return sa - sb;

          // 5) active trước inactive
          const aa = a.is_active ? 1 : 0;
          const ab = b.is_active ? 1 : 0;
          if (aa !== ab) return ab - aa;

          // 6) nhiều response hơn trước
          const ca = countMap.get(a.id) || 0;
          const cb = countMap.get(b.id) || 0;
          return cb - ca;
        });

        ep = candidates[0];
      }
    }

    if (!ep) return next();
    // Nếu endpoint vẫn stateless nhưng đã inactive ⇒ không phục vụ
    if (!ep.is_stateful && ep.is_active === false) {
      return next(); // rơi về 404 Express (đúng kỳ vọng vì đã chuyển stateful)
    }

    // Nếu endpoint là STATEFUL thì NHƯỜNG CHO universalHandler + statefulHandler
    // để trả đúng format { code, message, data, success }
    if (ep.is_stateful === true) {
      return next();
    }

    // 🔐 CHECK ACCESS CONTROL cho STATELESS endpoints
    // Nếu folder là PRIVATE (is_public=false), cần đăng nhập với tất cả method
    // Nếu folder là PUBLIC (is_public=true), không cần auth cho bất kỳ method nào
    if (ep.is_public === false) {
      // Private folder - require authentication for ALL methods
      const uid = await getSafeUserId(req);
      if (uid == null) {
        // Không có user → trả 401
        const status = 401;
        const body = { error: "Unauthorized: login required" };
        const _log = await logSvc.insertLog(req.db.stateless, {
          project_id: ep.project_id || null,
          endpoint_id: ep.id,
          user_id: null,
          request_method: method,
          request_path: req.path,
          request_headers: req.headers || {},
          request_body: req.body || {},
          response_status_code: status,
          response_body: body,
          ip_address: getClientIp(req),
          latency_ms: Date.now() - started,
        });
        console.log("[stateless] private folder, no auth, logged. _log =", _log);
        return res.status(status).json(body);
      }
    }

    // Helper function để validate dữ liệu dựa trên schema
    const validateSchema = (schema, data) => {
      const errors = [];
      if (!schema || typeof schema !== "object") {
        return errors; // Bỏ qua nếu không có schema
      }

      for (const key in schema) {
        const rule = schema[key];
        const value = data[key];

        // 1. Kiểm tra trường bắt buộc
        if (rule.required && typeof value === "undefined") {
          errors.push(`Field '${key}' is required.`);
          continue; // Bỏ qua các kiểm tra khác nếu thiếu
        }

        // 2. Kiểm tra kiểu dữ liệu (nếu trường đó tồn tại)
        if (typeof value !== "undefined") {
          const expectedType = rule.type.toLowerCase();
          const actualType = Array.isArray(value) ? "array" : typeof value;

          if (actualType !== expectedType) {
            errors.push(`Field '${key}' must be of type '${expectedType}', but received '${actualType}'.`);
          }
        }
      }
      return errors;
    };
    if (ep.is_stateful) {
      //  STATEFUL

      // 1. Lấy dữ liệu stateful từ Mongo
      const colName = ep.path.replace(/^\//, "");
      const col = getCollection(colName);
      const doc = (await col.findOne({})) || {
        data_current: [],
        data_default: [],
      };

      // Chuẩn hoá currentData thành mảng
      const currentData = Array.isArray(doc.data_current) ? doc.data_current : doc.data_current ? [doc.data_current] : [];

      // Lấy schema ở PG (đúng với thiết kế endpoints_ful.schema)
      const { rows: schRows } = await req.db.stateful.query("SELECT schema FROM endpoints_ful WHERE path = $1 LIMIT 1", [ep.path]);
      const schema = schRows?.[0]?.schema || null;

      const method = req.method.toUpperCase();
      const matchRes = getMatcher(ep.path)(pathForMatch);
      const params = (matchRes && matchRes.params) || {};

      switch (method) {
        case "GET": {
          const epFulId = await getEndpointsFulId(req.db.stateful, ep.id);

          const candidates = pickIdsFromReq(req);
          if (candidates.length) {
            const item = currentData.find((d) => candidates.includes(String(d?.id)));
            if (item) return res.status(200).json(item);
            const nf = await getTemplateResponse(req.db.stateful, epFulId, "Get Detail Not Found", {
              status_code: 404,
              response_body: { message: "Resource not found." },
            });
            return res.status(nf.status_code).json(nf.response_body);
          }
          return res.status(200).json(currentData);
        }

        case "POST": {
          // Xử lý POST: Thêm mới dữ liệu
          const epFulId = await getEndpointsFulId(req.db.stateful, ep.id);
          const newItem = req.body; // schema đã có ở trên từ PG

          //  BƯỚC 1: VALIDATE SCHEMA
          const validationErrors = validateSchema(schema, newItem);
          if (validationErrors.length > 0) {
            const errResponse = await getTemplateResponse(req.db.stateful, epFulId, "Schema Invalid", {
              status_code: 400,
              response_body: { error: "Schema validation failed" },
            });
            return res.status(errResponse.status_code).json({
              ...errResponse.response_body,
              details: validationErrors,
            });
          }

          // KIỂM TRA ID VÀ TẠO MỚI
          if (typeof newItem.id !== "undefined") {
            const idExists = currentData.some((item) => String(item.id) === String(newItem.id));
            if (idExists) {
              const errResponse = await getTemplateResponse(req.db.stateful, epFulId, "ID Conflict", {
                status_code: 409,
                response_body: {
                  error: `Conflict: An item with id '${newItem.id}' already exists.`,
                },
              });
              return res.status(errResponse.status_code).json(errResponse.response_body);
            }
          } else {
            const maxId = currentData.reduce((max, item) => (item.id > max ? item.id : max), 0);
            newItem.id = maxId + 1;
          }

          const newData = [...currentData, newItem];
          // Cập nhật lại Mongo
          await col.updateOne({}, { $set: { data_current: newData } }, { upsert: true });
          return res.status(201).json(newItem);
        }

        case "PUT": {
          //  Logic cho PUT
          return res.status(501).json({ message: "PUT method not implemented yet." });
        }

        case "DELETE": {
          // Logic cho DELETE
          return res.status(501).json({ message: "DELETE method not implemented yet." });
        }

        default: {
          return res.status(405).json({
            error: `Method ${method} not allowed for this stateful endpoint.`,
          });
        }
      }
      //  kết thúc xử lý stateful
    }

    // Logic cho stateless endpoints
    const hasParams = ep.path.includes(":") || ep.path.includes("*");
    const patForParams = hasParams ? ep.path : buildLoosePatternIfNeeded(ep.path);
    const matchRes = getMatcher(patForParams, hasParams)(pathForMatch);
    const params = (matchRes && matchRes.params) || {};
    const hasParamsInUrl = Object.keys(params).length > 0;

    const { rows: responses } = await req.db.stateless.query(
      `SELECT id, endpoint_id, name, status_code, response_body, is_default, priority, condition, delay_ms, proxy_url, proxy_method 
       FROM endpoint_responses WHERE endpoint_id = $1 
       ORDER BY is_default DESC, priority ASC NULLS LAST, updated_at DESC, created_at DESC`,
      [ep.id]
    );

    if (responses.length === 0) {
      // Default responses for different methods
      let status, body;
      switch (method) {
        case "GET":
          status = 200;
          body = hasParamsInUrl ? {} : [];
          break;
        case "POST":
          status = 201;
          body = { message: "Created successfully", data: req.body };
          break;
        case "PUT":
          status = 200;
          body = { message: "Updated successfully", data: req.body };
          break;
        case "DELETE":
          status = 200;
          body = { message: "Deleted successfully", data: null };
          break;
        default:
          status = 405;
          body = { error: "Method Not Allowed" };
      }

      // ✅ Validate user_id trước khi ghi log
      const validUserId = await validateUserIdForLog(req, safeUserId);

      try {
        const _log = await logSvc.insertLog(req.db.stateless, {
          project_id: ep.project_id || null,
          endpoint_id: ep.id,
          endpoint_response_id: null,
          user_id: validUserId,
          request_method: method,
          request_path: req.path,
          request_headers: req.headers || {},
          request_body: req.body || {},
          response_status_code: status,
          response_body: body,
          ip_address: getClientIp(req),
          latency_ms: Date.now() - started,
        });
        console.log("[after insertLog] _log =", _log);
        let logId = _log && _log.id;
        if (!logId) {
          try {
            const { rows } = await req.db.stateless.query(`SELECT id FROM project_request_logs ORDER BY id DESC LIMIT 1`);
            logId = rows?.[0]?.id || null;
            console.log("[after insertLog] fallback logId =", logId);
          } catch (e) {
            console.error("[after insertLog] fallback query failed:", e?.message || e);
          }
        }
      } catch (_) {}
      return res.status(status).json(body);
    }

    const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

    // Chuẩn hoá headers về lowercase key để so sánh case-insensitive
    const normalizeHeaderKeys = (h = {}) => {
      const out = {};
      for (const [k, v] of Object.entries(h || {})) {
        if (k == null) continue;
        out[String(k).toLowerCase()] = v;
      }
      return out;
    };

    const matchesCondition = (cond) => {
      if (!isPlainObject(cond)) return false;
      const hasParamsRules = isPlainObject(cond.params) && Object.keys(cond.params).length > 0;
      const hasQueryRules = isPlainObject(cond.query) && Object.keys(cond.query).length > 0;
      const hasHeaderRules = isPlainObject(cond.headers) && Object.keys(cond.headers).length > 0;
      const hasBodyRules = isPlainObject(cond.body) && Object.keys(cond.body).length > 0;

      // Nếu không có rule nào được khai báo thì coi như "không dùng condition" → không match
      if (!hasParamsRules && !hasQueryRules && !hasHeaderRules && !hasBodyRules) {
        return false;
      }

      // params
      if (hasParamsRules) {
        for (const [k, v] of Object.entries(cond.params)) {
          if (String(params[k] ?? "") !== String(v)) return false;
        }
      }

      // query
      if (hasQueryRules) {
        for (const [k, v] of Object.entries(cond.query)) {
          if (String(req.query[k] ?? "") !== String(v)) return false;
        }
      }

      // headers (so sánh key lower-case, value stringify)
      if (hasHeaderRules) {
        const reqHeadersLc = normalizeHeaderKeys(req.headers || {});
        for (const [k, v] of Object.entries(cond.headers)) {
          const actual = reqHeadersLc[String(k).toLowerCase()];
          if (actual === undefined) return false;
          if (String(actual) !== String(v)) return false;
        }
      }

      // body: yêu cầu cond.body là "subset" của req.body (so sánh shallow + deep JSON nếu là object)
      if (hasBodyRules) {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        for (const [k, expected] of Object.entries(cond.body)) {
          const actual = body[k];
          if (actual === undefined) return false;
          if (expected != null && typeof expected === "object") {
            // deep compare đơn giản
            if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
          } else {
            if (String(actual) !== String(expected)) return false;
          }
        }
      }

      return true;
    };

    const matchedResponses = responses.filter((r) => matchesCondition(r.condition));
    let r;
    if (matchedResponses.length > 0) {
      // Sắp xếp các response theo priority (priority thấp nhất được ưu tiên)
      matchedResponses.sort((a, b) => a.priority - b.priority); // Sắp xếp theo priority từ thấp đến cao
      r = matchedResponses[0]; // Trả về response có priority thấp nhất
    } else {
      r = responses.find((rr) => rr.is_default);
      if (!r) {
        const status = 404;
        const body = { error: "No matching response found" };
        const _log = await logSvc.insertLog(req.db.stateless, {
          project_id: ep.project_id || null,
          endpoint_id: ep.id,
          user_id: safeUserId,
          request_method: method,
          request_path: req.path,
          response_status_code: status,
          response_body: body,
          ip_address: getClientIp(req),
          latency_ms: Date.now() - started,
        });
        console.log("[after insertLog] _log =", _log);
        let logId = _log && _log.id;
        if (!logId) {
          try {
            const { rows } = await req.db.stateless.query(`SELECT id FROM project_request_logs ORDER BY id DESC LIMIT 1`);
            logId = rows?.[0]?.id || null;
            console.log("[after insertLog] fallback logId =", logId);
          } catch (e) {
            console.error("[after insertLog] fallback query failed:", e?.message || e);
          }
        }

        return res.status(status).json(body);
      }
    }

    if (r.proxy_url) {
      // Khối logic proxy
      const delay = r.delay_ms ?? 0;
      const handleProxyRequest = async () => {
        const finished = Date.now();
        try {
          // Build context có đủ path/tail/query
          const reqPath = req.universal?.subPath || req.path || "";
          const matcher = getMatcher(patForParams, hasParams);
          const m = matcher(reqPath);
          const baseMatched = (m && m.path) || ""; // phần path khớp với endpoint
          const tail = reqPath.slice(baseMatched.length); // phần path người dùng "nối thêm"
          const ctx = {
            params,
            query: req.query,
            path: reqPath,
            basePath: baseMatched,
            tail,
            queryString: new URLSearchParams(req.query || {}).toString(),
          };

          // Nếu user có dùng {{path}} hoặc {{tail}} trong proxy_url
          // thì coi như họ tự control path → mình không đụng vào nữa.
          const hasCustomPath = /\{\{\s*(path|tail)\s*\}\}/.test(r.proxy_url || "");
          let resolvedUrl = renderTemplate(r.proxy_url, ctx);

          try {
            const u = new URL(resolvedUrl);

            const forwardPath = req.universal?.subPath || req.path || "/";
            const proxyPath = u.pathname || "/";

            // Chỉ override khi proxy_url KHÔNG có path gì (chỉ là host root "/")
            if (!hasCustomPath && (proxyPath === "/" || proxyPath === "")) {
              // MẶC ĐỊNH: forward đúng subPath/path mà client gọi vào mock
              // Ví dụ: /api/v1/groups hoặc /api/v1/groups/:group_id/queue
              u.pathname = forwardPath;
            }

            // Luôn merge thêm query từ request nếu upstream chưa có
            for (const [k, v] of Object.entries(req.query || {})) {
              if (!u.searchParams.has(k)) u.searchParams.append(k, v);
            }

            resolvedUrl = u.toString();
          } catch {}

          console.log("[Proxy debug]", {
            endpointPath: ep.path,
            subPath: req.universal?.subPath,
            resolvedUrl,
          });

          const contentType = (req.headers["content-type"] || "").toLowerCase();
          let axiosConfig = {
            method: r.proxy_method || req.method,
            url: resolvedUrl,
            validateStatus: () => true,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
          };

          // Chuẩn hoá header forward & Authorization override
          const authOverride = resolveAuthOverride(req);
          let fwdHeaders = sanitizeForwardHeaders(req.headers);
          if (authOverride) {
            fwdHeaders["Authorization"] = authOverride;
          }
          // Default UA để giảm CF block
          fwdHeaders["User-Agent"] = fwdHeaders["User-Agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

          // --- Detect multipart/form-data (upload) ---
          if (contentType.includes("multipart/form-data") && req.files) {
            const form = new FormData();
            Object.entries(req.body || {}).forEach(([key, val]) => form.append(key, val));
            for (const [field, files] of Object.entries(req.files)) {
              const arr = Array.isArray(files) ? files : [files];
              for (const f of arr) {
                // express-fileupload: f.data là Buffer, f.name là tên file
                form.append(field, f.data, {
                  filename: f.name,
                  contentType: f.mimetype,
                });
              }
            }
            // --- FIX: thêm Content-Length để tránh socket hang up ---
            const formHeaders = form.getHeaders();
            const contentLength = await new Promise((resolve, reject) => {
              form.getLength((err, length) => {
                if (err) reject(err);
                else resolve(length);
              });
            });
            axiosConfig.data = form;
            axiosConfig.headers = {
              ...fwdHeaders,
              ...formHeaders,
              "Content-Length": contentLength,
            };
            console.log("🚀 Forwarding proxy to", resolvedUrl);
            console.log("🧾 Headers to proxy:", {
              ...axiosConfig.headers,
              Authorization: axiosConfig.headers.Authorization ? "[REDACTED]" : undefined,
            });
          } else {
            axiosConfig.data = req.body;
            axiosConfig.headers = fwdHeaders;
          }

          // Thử gọi bằng axios trước
          let proxyResp;
          try {
            proxyResp = await axios(axiosConfig);
          } catch (axiosErr) {
            // nếu axios có response kèm theo, lấy nó để decide fallback
            proxyResp = axiosErr?.response || null;
          }
          // Nếu upstream không trả response (network error, timeout...), trả 502 an toàn
          if (!proxyResp) {
            const status = 502;
            const safeBody = {
              error: "Bad Gateway (no upstream response)",
              message: "Upstream server did not return a response.",
            };
            const _log = await logSvc.insertLog(req.db.stateless, {
              project_id: ep.project_id || null,
              endpoint_id: ep.id,
              endpoint_response_id: r.id || null,
              user_id: safeUserId,
              request_method: method,
              request_path: req.path,
              request_headers: req.headers || {},
              request_body: req.body || {},
              response_status_code: status,
              response_body: safeBody,
              ip_address: getClientIp(req),
              latency_ms: Date.now() - started,
            });
            let logId = _log && _log.id;
            if (!logId) {
              try {
                const { rows } = await req.db.stateless.query(`SELECT id FROM project_request_logs ORDER BY id DESC LIMIT 1`);
                logId = rows?.[0]?.id || null;
              } catch (e) {}
            }

            return res.status(status).json(safeBody);
          }

          const looksLikeCloudflareBlock = (r) => {
            if (!r) return false;
            const ct = String(r.headers?.["content-type"] || "").toLowerCase();
            const isHtml = ct.includes("text/html");
            const bodyStr = typeof r.data === "string" ? r.data : r.data && typeof r.data === "object" ? JSON.stringify(r.data) : "";

            // Chỉ coi là CF challenge khi là HTML & có dấu hiệu challenge
            if (!isHtml) return false;
            return bodyStr.includes("Attention Required") || bodyStr.includes("cf-chl") || bodyStr.includes("Checking your browser");
          };

          if (looksLikeCloudflareBlock(proxyResp)) {
            try {
              console.warn("[Proxy] axios returned 403/Cloudflare HTML — trying cloudscraper fallback");

              // Build headers for cloudscraper - keep important ones
              const csHeaders = {
                "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                Accept: req.headers["accept"] || "*/*",
                Referer: req.headers["referer"] || `https://${new URL(resolvedUrl).hostname}/`,
              };
              // Ưu tiên override nếu có
              if (authOverride) csHeaders["Authorization"] = authOverride;
              else if (req.headers["authorization"]) csHeaders["Authorization"] = req.headers["authorization"];

              // If multipart -> build formData object acceptable by cloudscraper (request lib)
              if (contentType.includes("multipart/form-data") && req.files) {
                const csForm = {};
                Object.entries(req.body || {}).forEach(([k, v]) => {
                  csForm[k] = v;
                });
                for (const [field, files] of Object.entries(req.files)) {
                  const arr = Array.isArray(files) ? files : [files];
                  for (const f of arr) {
                    // cloudscraper/request accepts Buffer with options
                    csForm[field] = csForm[field] || [];
                    csForm[field].push({
                      value: f.data, // Buffer
                      options: { filename: f.name, contentType: f.mimetype },
                    });
                  }
                }

                // cloudscraper with formData (resolveWithFullResponse để lấy status)
                const csResp = await cloudscraper({
                  method: axiosConfig.method || "POST",
                  uri: resolvedUrl,
                  formData: csForm,
                  headers: csHeaders,
                  gzip: true, // ✅ tự động decompress
                  resolveWithFullResponse: true,
                  simple: false,
                });

                const zlib = require("zlib");
                let decodedBody = csResp.body;
                // Nếu server trả gzip/deflate/br -> tự giải nén
                const enc = csResp.headers["content-encoding"];
                try {
                  if (Buffer.isBuffer(csResp.body)) {
                    if (enc === "gzip") decodedBody = zlib.gunzipSync(csResp.body);
                    else if (enc === "deflate") decodedBody = zlib.inflateSync(csResp.body);
                    else if (enc === "br") decodedBody = zlib.brotliDecompressSync(csResp.body);
                  }
                  if (Buffer.isBuffer(decodedBody)) decodedBody = decodedBody.toString("utf8");
                } catch (deErr) {
                  console.warn("[Proxy decompress warn]", deErr.message);
                }

                proxyResp = {
                  status: csResp.statusCode,

                  data: (() => {
                    try {
                      return JSON.parse(decodedBody);
                    } catch {
                      return decodedBody;
                    }
                  })(),
                  headers: (() => {
                    const h = { ...csResp.headers };
                    delete h["content-encoding"]; // tránh decompress lỗi ở client
                    delete h["transfer-encoding"];
                    return h;
                  })(),
                  headers: sanitizeResponseHeaders(csResp.headers),
                };
              } else {
                // Non-multipart: send JSON/body via cloudscraper
                const csResp = await cloudscraper({
                  method: axiosConfig.method || "GET",
                  uri: resolvedUrl,
                  body: axiosConfig.data,
                  headers: { ...csHeaders, "Content-Type": req.headers["content-type"] || "application/json" },
                  gzip: true, // ✅ tự động decompress
                  json: true,
                  resolveWithFullResponse: true,
                  simple: false,
                });
                proxyResp = {
                  status: csResp.statusCode,
                  data: csResp.body,
                  headers: sanitizeResponseHeaders(csResp.headers),
                };
              }
            } catch (csErr) {
              console.error("[Proxy cloudscraper error]", csErr && csErr.message ? csErr.message : csErr);
              // if fallback fails, return original axios error if present
              // return res.status(502).json({
              //   error: "Bad Gateway (proxy failed)",
              //   message: csErr?.message || "cloudscraper fallback failed",
              //   detail: csErr?.response || null,
              // });
            }
          }
          let safeResponseBody;
          if (proxyResp.data && typeof proxyResp.data === "object") {
            safeResponseBody = proxyResp.data;
          } else {
            safeResponseBody = {
              non_json_response: true,
              raw_body: String(proxyResp.data ?? ""),
            };
          }
          const outHeaders = sanitizeResponseHeaders(proxyResp.headers);
          console.log(`[Proxy] ${axiosConfig.method || req.method} ${resolvedUrl} -> ${proxyResp.status}`);
          const _log = await logSvc.insertLog(req.db.stateless, {
            project_id: ep.project_id || null,
            endpoint_id: ep.id,
            endpoint_response_id: r.id || null,
            user_id: await validateUserIdForLog(req, safeUserId),
            request_method: method,
            request_path: req.path,
            request_headers: req.headers || {},
            request_body: req.body || {},
            response_status_code: proxyResp.status,
            response_body: safeResponseBody,
            ip_address: getClientIp(req),
            latency_ms: finished - started,
          });
          console.log("[after insertLog] _log =", _log);
          let logId = _log && _log.id;
          if (!logId) {
            try {
              const { rows } = await req.db.stateless.query(`SELECT id FROM project_request_logs ORDER BY id DESC LIMIT 1`);
              logId = rows?.[0]?.id || null;
              console.log("[after insertLog] fallback logId =", logId);
            } catch (e) {
              console.error("[after insertLog] fallback query failed:", e?.message || e);
            }
          }

          return res.status(proxyResp.status).set(outHeaders).send(proxyResp.data);
        } catch (err) {
          console.error("[Proxy Error]", err.message, err.code, err?.response?.status, err?.response?.statusText);
          if (err?.response) {
            console.error("[Proxy Response Data]", err.response.data);
          }
          return res.status(502).json({
            error: "Bad Gateway (proxy failed)",
            message: err.message,
            code: err.code,
            status: err?.response?.status || null,
            response: err?.response?.data || null,
          });
        }
      };
      if (delay > 0) {
        setTimeout(handleProxyRequest, delay);
      } else {
        await handleProxyRequest();
      }
    } else {
      // Khối logic response thông thường
      const status = r.status_code || 200;
      let body = r.response_body ?? null;
      const delay = r.delay_ms ?? 0;
      const ctx = { params, query: req.query };
      if (body && (typeof body === "object" || typeof body === "string")) {
        body = renderTemplate(body, ctx);
      }
      const sendResponse = async () => {
        const finished = Date.now();
        const _log = await logSvc.insertLog(req.db.stateless, {
          project_id: ep.project_id || null,
          endpoint_id: ep.id,
          endpoint_response_id: r.id || null,
          user_id: await validateUserIdForLog(req, safeUserId),
          request_method: method,
          request_path: req.path,
          request_headers: req.headers || {},
          request_body: req.body || {},
          response_status_code: status,
          response_body: body,
          ip_address: getClientIp(req),
          latency_ms: finished - started,
        });
        console.log("[after insertLog] _log =", _log);
        let logId = _log && _log.id;
        if (!logId) {
          try {
            const { rows } = await req.db.stateless.query(`SELECT id FROM project_request_logs ORDER BY id DESC LIMIT 1`);
            logId = rows?.[0]?.id || null;
            console.log("[after insertLog] fallback logId =", logId);
          } catch (e) {
            console.error("[after insertLog] fallback query failed:", e?.message || e);
          }
        }

        if (body && typeof body === "object") {
          return res.status(status).json(body);
        }
        return res.status(status).send(body ?? "");
      };
      if (delay > 0) {
        setTimeout(sendResponse, delay);
      } else {
        await sendResponse();
      }
    }
  } catch (err) {
    try {
      const _log = await logSvc.insertLog(req.db.stateless, {
        project_id: null,
        endpoint_id: null,
        user_id: safeUserId,
        request_method: req.method?.toUpperCase?.() || "",
        request_path: req.path || req.originalUrl || "",
        response_status_code: 500,
        response_body: { error: "Internal Server Error", message: err.message },
        ip_address: getClientIp(req),
        latency_ms: Date.now() - started,
      });
      console.log("[after insertLog] _log =", _log);
      let logId = _log && _log.id;
      if (!logId) {
        try {
          const { rows } = await req.db.stateless.query(`SELECT id FROM project_request_logs ORDER BY id DESC LIMIT 1`);
          logId = rows?.[0]?.id || null;
          console.log("[after insertLog] fallback logId =", logId);
        } catch (e) {
          console.error("[after insertLog] fallback query failed:", e?.message || e);
        }
      }
    } catch (logErr) {
      console.error("CRITICAL: Failed to log an unexpected error.", logErr);
    }
    return next(err);
  }
});
// Export router
module.exports = router;
