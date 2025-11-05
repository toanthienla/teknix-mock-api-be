const express = require("express");
const { match } = require("path-to-regexp");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
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
    const raw = req.user && req.user.id != null ? req.user.id : null;
    const idNum = Number(raw);
    if (!Number.isInteger(idNum) || idNum <= 0) return null;
    const { rows } = await req.db.stateless.query("SELECT 1 FROM users WHERE id = $1 LIMIT 1", [idNum]);
    return rows && rows[0] ? idNum : null;
  } catch (e) {
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

router.use(authMiddleware, async (req, res, next) => {
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
      `SELECT e.id, e.method, e.path, e.folder_id, e.is_stateful, e.is_active, f.project_id
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

    // Ưu tiên endpoint đúng project nếu universal cung cấp projectId,
    // còn nếu không có projectId (gọi thẳng /cat) thì chọn ứng viên "tốt nhất":
    // stateless trước, active trước, và có response trước.
    let ep = null;
    if (matches.length > 0) {
      if (req.universal && req.universal.projectId) {
        ep = matches.find((e) => e.project_id === req.universal.projectId) || matches[0];
      } else {
        // Lấy danh sách id để kiểm tra có response hay không
        const ids = matches.map((m) => m.id);
        const { rows: respCounts } = await req.db.stateless.query(
          `SELECT endpoint_id, COUNT(*)::int AS cnt
             FROM endpoint_responses
            WHERE endpoint_id = ANY($1)
            GROUP BY endpoint_id`,
          [ids]
        );
        const countMap = new Map(respCounts.map((r) => [Number(r.endpoint_id), Number(r.cnt)]));
        // xếp hạng: stateless > active > có response
        matches.sort((a, b) => {
          const sa = a.is_stateful ? 1 : 0;
          const sb = b.is_stateful ? 1 : 0;
          if (sa !== sb) return sa - sb; // stateless (0) trước stateful (1)
          const aa = a.is_active ? 1 : 0;
          const ab = b.is_active ? 1 : 0;
          if (aa !== ab) return ab - aa; // active (1) trước inactive (0)
          const ca = countMap.get(a.id) || 0;
          const cb = countMap.get(b.id) || 0;
          return cb - ca; // nhiều response trước
        });
        ep = matches[0];
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
      const status = req.method.toUpperCase() === "GET" ? 200 : 501;
      const body = req.method.toUpperCase() === "GET" ? (hasParamsInUrl ? {} : []) : { error: { message: "No response configured" } };
      try {
        const _log = await logSvc.insertLog(req.db.stateless, {
          project_id: ep.project_id || null,
          endpoint_id: ep.id,
          endpoint_response_id: null,
          user_id: safeUserId,
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
    const matchesCondition = (cond) => {
      if (!isPlainObject(cond) || Object.keys(cond).length === 0) return false;
      if (isPlainObject(cond.params)) {
        for (const [k, v] of Object.entries(cond.params)) {
          if (String(params[k] ?? "") !== String(v)) return false;
        }
      }
      if (isPlainObject(cond.query)) {
        for (const [k, v] of Object.entries(cond.query)) {
          if (String(req.query[k] ?? "") !== String(v)) return false;
        }
      }
      return true;
    };

    const matchedResponses = responses.filter((r) => matchesCondition(r.condition));
    let r;
    if (matchedResponses.length > 0) {
      r = matchedResponses[0];
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
          const ctx = { params, query: req.query };
          const resolvedUrl = renderTemplate(r.proxy_url, ctx);
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

          // Nếu bị 403 hoặc nhận HTML Cloudflare (Attention Required...), thử fallback bằng cloudscraper
          const looksLikeCloudflareBlock = (r) => {
            if (!r) return false;
            try {
              const body = typeof r.data === "string" ? r.data : r.data && typeof r.data === "object" ? JSON.stringify(r.data) : "";
              if (r.status === 403) return true;
              if (typeof body === "string" && body.includes("Attention Required")) return true;
            } catch (e) {}
            return false;
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
              return res.status(502).json({
                error: "Bad Gateway (proxy failed)",
                message: csErr?.message || "cloudscraper fallback failed",
                detail: csErr?.response || null,
              });
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
            user_id: safeUserId,
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
          user_id: safeUserId,
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

module.exports = router;
