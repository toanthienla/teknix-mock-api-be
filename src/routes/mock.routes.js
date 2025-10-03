const express = require("express");
const { match } = require("path-to-regexp");
const router = express.Router();
const axios = require("axios");
const https = require("https");

const logSvc = require("../services/project_request_log.service");

const matcherCache = new Map();

function getMatcher(pattern) {
  let fn = matcherCache.get(pattern);
  if (!fn) {
    fn = match(pattern, { decode: decodeURIComponent, strict: true, end: true });
    matcherCache.set(pattern, fn);
  }
  return fn;
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
  const replaceInString = (str) => str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, vpath) => {
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
  try {
    const method = req.method.toUpperCase();
    
    const { rows: endpoints } = await req.db.stateless.query(
      `SELECT e.id, e.method, e.path, e.folder_id, e.is_stateful, f.project_id
       FROM endpoints e
       JOIN folders f ON e.folder_id = f.id
       WHERE UPPER(e.method) = $1 AND e.is_active = true`,
      [method]
    );

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
      // Logic cho stateful endpoints 
      const { rows: dataRows } = await req.db.stateful.query("SELECT data_current FROM endpoint_data WHERE path = $1", [ep.path]);
      if (dataRows.length === 0) {
        return res.status(404).json({ error: `Stateful data for path '${ep.path}' not found.` });
      }
      return res.status(200).json(dataRows[0].data_current);
    } 
    
    // Logic cho stateless endpoints
    const matchFn = getMatcher(ep.path);
    const matchRes = matchFn(req.path);
    const params = (matchRes && matchRes.params) || {};
    const hasParams = Object.keys(params).length > 0;

    const { rows: responses } = await req.db.stateless.query(
      `SELECT id, endpoint_id, name, status_code, response_body, is_default, priority, condition, delay_ms, proxy_url, proxy_method 
       FROM endpoint_responses WHERE endpoint_id = $1 
       ORDER BY is_default DESC, priority ASC NULLS LAST, updated_at DESC, created_at DESC`,
      [ep.id]
    );

    if (responses.length === 0) {
      const status = req.method.toUpperCase() === "GET" ? 200 : 501;
      const body = req.method.toUpperCase() === "GET" ? (hasParams ? {} : []) : { error: { message: "No response configured" } };
      
      await logSvc.insertLog(req.db.stateless, { // SỬA Ở ĐÂY
        project_id: ep.project_id || null,
        endpoint_id: ep.id,
        request_method: method,
        request_path: req.path,
        response_status_code: status,
        response_body: body,
        ip_address: getClientIp(req),
        latency_ms: Date.now() - started,
      });
      return res.status(status).json(body);
    }

    const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
    const matchesCondition = (cond) => {
      if (!isPlainObject(cond) || Object.keys(cond).length === 0) return false;
      if (isPlainObject(cond.params)) {
        for (const [k, v] of Object.entries(cond.params)) { if (String(params[k] ?? "") !== String(v)) return false; }
      }
      if (isPlainObject(cond.query)) {
        for (const [k, v] of Object.entries(cond.query)) { if (String(req.query[k] ?? "") !== String(v)) return false; }
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
        await logSvc.insertLog(req.db.stateless, { // SỬA Ở ĐÂY
            project_id: ep.project_id || null,
            endpoint_id: ep.id,
            request_method: method,
            request_path: req.path,
            response_status_code: status,
            response_body: body,
            ip_address: getClientIp(req),
            latency_ms: Date.now() - started,
        });
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
            const proxyResp = await axios({
              method: r.proxy_method || req.method,
              url: resolvedUrl, data: req.body,
              validateStatus: () => true,
              httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            });
            let safeResponseBody;
            if (proxyResp.data && typeof proxyResp.data === 'object') {
                safeResponseBody = proxyResp.data;
            } else {
                safeResponseBody = { non_json_response: true, raw_body: String(proxyResp.data ?? '') };
            }
            await logSvc.insertLog(req.db.stateless, {
              project_id: ep.project_id || null,
              endpoint_id: ep.id,
              endpoint_response_id: r.id || null,
              request_method: method,
              request_path: req.path,
              request_headers: req.headers || {},
              request_body: req.body || {},
              response_status_code: proxyResp.status,
              response_body: safeResponseBody,
              ip_address: getClientIp(req),
              latency_ms: finished - started,
            });
            return res.status(proxyResp.status).set(proxyResp.headers).send(proxyResp.data);
          } catch (err) {
            return res.status(502).json({ error: "Bad Gateway (proxy failed)" });
          }
        };
        if (delay > 0) { setTimeout(handleProxyRequest, delay); } else { await handleProxyRequest(); }
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
          await logSvc.insertLog(req.db.stateless, {
            project_id: ep.project_id || null,
            endpoint_id: ep.id,
            endpoint_response_id: r.id || null,
            request_method: method,
            request_path: req.path,
            request_headers: req.headers || {},
            request_body: req.body || {},
            response_status_code: status,
            response_body: body,
            ip_address: getClientIp(req),
            latency_ms: finished - started,
          });
          if (body && typeof body === "object") { return res.status(status).json(body); }
          return res.status(status).send(body ?? "");
        };
        if (delay > 0) { setTimeout(sendResponse, delay); } else { await sendResponse(); }
    }
  } catch (err) {
    // Sửa khối catch cuối cùng
    try {
        await logSvc.insertLog(req.db.stateless, {
            project_id: null, // Không có context project_id ở đây
            endpoint_id: null,
            request_method: req.method?.toUpperCase?.() || "",
            request_path: req.path || req.originalUrl || "",
            response_status_code: 500,
            response_body: { error: "Internal Server Error", message: err.message },
            ip_address: getClientIp(req),
            latency_ms: Date.now() - started,
        });
    } catch (logErr) {
        console.error("CRITICAL: Failed to log an unexpected error.", logErr);
    }
    return next(err);
  }
});

module.exports = router;