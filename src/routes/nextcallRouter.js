const express = require("express");
const router = express.Router();
const logSvc = require("../services/project_request_log.service");

console.log("[nextCalls] router loaded");

/* ========================================
 * Helpers
 * ====================================== */
function get(obj, path) {
  return path?.split(".").reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
}

// NEW: header helpers
function lowerCaseKeys(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[String(k).toLowerCase()] = v;
  return out;
}
const HEADER_BLOCKLIST = new Set(["content-length", "host", "connection", "accept-encoding", "transfer-encoding"]);
function mergeHeadersCI(base = {}, override = {}) {
  const baseLc = lowerCaseKeys(base);
  const overLc = lowerCaseKeys(override);
  const merged = { ...baseLc, ...overLc }; // override wins
  return merged;
}
function pickInheritedHeaders(src = {}, conf = { mode: "none", include: [], exclude: [] }) {
  const srcLc = lowerCaseKeys(src);
  const result = {};
  if (!conf || conf.mode === "none") return result;
  if (conf.mode === "all") {
    for (const [k, v] of Object.entries(srcLc)) {
      if (HEADER_BLOCKLIST.has(k)) continue;
      if (
        Array.isArray(conf.exclude) &&
        conf.exclude
          .map(String)
          .map((s) => s.toLowerCase())
          .includes(k)
      )
        continue;
      result[k] = v;
    }
    return result;
  }
  if (conf.mode === "list") {
    const includeLc = (conf.include || []).map((s) => String(s).toLowerCase());
    for (const name of includeLc) {
      const k = String(name).toLowerCase();
      if (HEADER_BLOCKLIST.has(k)) continue;
      if (k in srcLc) result[k] = srcLc[k];
    }
    // apply exclude after include (safety)
    const excludeLc = (conf.exclude || []).map((s) => String(s).toLowerCase());
    for (const ex of excludeLc) delete result[ex];
    return result;
  }
  return result;
}

/**
 * --- NEW ---
 * Select from history by 1-based index, then read a nested path
 * idx: 1 => history[0], 2 => history[1], ...
 */
function getFromHistory(history, idx1Based, subPath) {
  const i = Number(idx1Based);
  if (!Number.isFinite(i) || i < 1) return undefined;
  const entry = Array.isArray(history) ? history[i - 1] : undefined;
  if (!entry) return undefined;
  if (!subPath) return entry;
  return get(entry, subPath);
}

/**
 * renderTemplate:
 * - tpl: object/array/string containing {{...}} placeholders
 * - ctx: { root, prev, history }
 *
 * Support access patterns:
 *  - {{request.body.foo}} / {{response.body.foo}}  (back-compat; prev-first, then root)
 *  - {{1.request.body.name}} / {{2.response.body.data.age}} (history, 1-based)
 *  - {{root.res.status}}, {{prev.status}}
 */
function renderTemplate(obj, ctx = {}) {
  if (Array.isArray(obj)) return obj.map((v) => renderTemplate(v, ctx));
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [k, v] of Object.entries(obj)) result[k] = renderTemplate(v, ctx);
    return result;
  }

  if (typeof obj === "string") {
    // normalize prev.response to always have .body
    const rawPrevResponse = ctx.prev?.response;
    const normalizedPrevResponse = rawPrevResponse && typeof rawPrevResponse === "object" && !("body" in rawPrevResponse) ? { body: rawPrevResponse } : rawPrevResponse;

    const scope = {
      root: ctx.root,
      prev: ctx.prev,
      history: Array.isArray(ctx.history) ? ctx.history : [],
      request: ctx.prev?.request ?? ctx.root?.req ?? ctx.root?.request ?? {},
      response: normalizedPrevResponse ?? ctx.root?.res ?? ctx.root?.response ?? {},
    };

    return obj.replace(/\{\{([^}]+)\}\}/g, (_, exprRaw) => {
      try {
        const expr = exprRaw.trim();

        // --- NEW: history addressing "{{<n>.<rest>}}" ---
        const m = expr.match(/^(\d+)\.(.+)$/);
        if (m) {
          const idx = m[1];
          const rest = m[2];
          const val = getFromHistory(scope.history, idx, rest);
          return val == null ? "" : String(val);
        }

        // back-compat scope
        const parts = expr.split(".");
        let val = scope;
        for (const p of parts) {
          if (val == null) break;
          val = val[p];
        }
        return val ?? "";
      } catch {
        return "";
      }
    });
  }

  return obj;
}

/**
 * renderStringTemplate: for paths with {{...}}
 * - supports both history {{1.request...}} and back-compat {{request...}}
 */
function renderStringTemplate(tpl, ctx = {}) {
  if (!tpl || typeof tpl !== "string") return tpl;

  const scope = {
    root: ctx.root,
    prev: ctx.prev,
    history: Array.isArray(ctx.history) ? ctx.history : [],
    request: ctx.prev?.request ?? ctx.root?.req ?? ctx.root?.request ?? {},
    response: ctx.prev?.response ?? ctx.root?.res ?? ctx.root?.response ?? {},
  };

  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, exprRaw) => {
    const expr = exprRaw.trim();

    // NEW: history addressing
    const m = expr.match(/^(\d+)\.(.+)$/);
    if (m) {
      const idx = m[1];
      const rest = m[2];
      const val = getFromHistory(scope.history, idx, rest);
      return typeof val === "undefined" ? "" : String(val);
    }

    const val = get(scope, expr);
    return typeof val === "undefined" ? "" : String(val);
  });
}

function checkCondition(cond, { root, prev }) {
  if (typeof cond === "number") {
    const base = prev && typeof prev.status !== "undefined" ? prev.status : root?.res?.status;
    console.log(`[nextCalls] cond-eval(shorthand-number) use=${prev ? "prev.status" : "root.status"} actual=${base} expect=${cond}`);
    return Number(base) === Number(cond);
  }
  if (typeof cond === "boolean") {
    console.log(`[nextCalls] cond-eval(shorthand-bool) value=${cond}`);
    return cond;
  }

  if (!cond) return true;

  const source = cond.source ?? (prev ? "prev" : "root");
  const src = source === "prev" ? prev : root?.res;
  const val = get(src, cond.path);
  const op = cond.op || "truey";
  console.log(`[nextCalls] cond-eval source=${source} path=${cond?.path || "(none)"} val=${JSON.stringify(val)} op=${op} expect=${JSON.stringify(cond?.value)}`);
  switch (op) {
    case "eq":
      return val === cond.value;
    case "neq":
      return val !== cond.value;
    case "gt":
      return Number(val) > Number(cond.value);
    case "lt":
      return Number(val) < Number(cond.value);
    case "in":
      return Array.isArray(cond.value) && cond.value.includes(val);
    case "notin":
      return Array.isArray(cond.value) && !cond.value.includes(val);
    case "exists":
      return typeof val !== "undefined";
    case "truey":
      return !!val;
    default:
      return false;
  }
}

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function createMemoryResponder() {
  const store = { status: 200, headers: {}, body: null };
  return {
    status(code) {
      store.status = code;
      return this;
    },
    set(k, v) {
      store.headers[String(k).toLowerCase()] = v;
    },
    setHeader(k, v) {
      // <── THÊM ALIAS NÀY
      this.set(k, v);
    },
    json(obj) {
      store.body = obj;
      return this;
    },
    send(obj) {
      store.body = obj;
      return this;
    },
    toJSON() {
      return { ...store };
    },
  };
}

/**
 * --- UPDATED ---
 * - Accept full URL in target_endpoint ("http://host/W/P/path") or plain "/W/P/path"
 * - Allow snake_case delay_ms/timeout_ms
 */
function buildPlanFromAdvancedConfig(nextCalls = []) {
  const arr = Array.isArray(nextCalls) ? nextCalls : [];
  const plan = arr.map((s) => {
    let workspace = null,
      project = null,
      logicalPath = null,
      externalUrl = null; // NEW

    let raw = typeof s?.target_endpoint === "string" ? s.target_endpoint : "";

    // Accept full URL and preserve it
    if (/^https?:\/\//i.test(raw)) {
      externalUrl = raw; // keep full URL for proxy
      try {
        const u = new URL(raw);
        raw = u.pathname || "/";
      } catch {
        // keep raw as-is
      }
    }

    if (typeof raw === "string") {
      const m = raw.match(/^\/([^/]+)\/([^/]+)(\/.*)$/);
      if (m) {
        workspace = m[1];
        project = m[2];
        logicalPath = m[3];
      }
    }

    return {
      name: s?.name || `step-${s?.id ?? ""}`.trim(),
      target: {
        workspace,
        project,
        method: (s?.method || "GET").toUpperCase(),
        logicalPath: logicalPath || "",
        externalUrl,
      },
      payload: { template: s?.body || {} },
      headers: { template: s?.headers || {} },
      condition: typeof s?.condition !== "undefined" ? s.condition : null,
      delayMs: Number(s?.delayMs ?? s?.delay_ms) || 0,
      timeoutMs: Number(s?.timeoutMs ?? s?.timeout_ms) || 0,
      log: {
        // mặc định persist = true, chỉ tắt khi log.persist === false
        persist: s?.log?.persist !== false,
        notify: !!s?.log?.notify,
      },
      auth: { mode: s?.auth?.mode || "same-user" },
    };
  });
  console.log(`[nextCalls] plan normalized: count=${plan.length}`);
  return plan;
}

async function resolveTargetEndpoint(step, { defaultWorkspace, defaultProject, statefulDb, statelessDb }) {
  const t = step.target || {};
  const method = (t.method || "GET").toUpperCase();
  const workspaceName = t.workspace || defaultWorkspace;
  const projectName = t.project || defaultProject;
  const logicalPath = String(t.logicalPath || "").replace(/\/:id$/, "");

  console.log(`[nextCalls] resolve: method=${method} ws=${workspaceName} pj=${projectName} path=${logicalPath}`);

  // find project (stateless)
  const pj = await statelessDb.query(
    `SELECT p.id
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
      WHERE LOWER(p.name)=LOWER($1) AND LOWER(w.name)=LOWER($2)
      LIMIT 1`,
    [projectName, workspaceName]
  );
  const project = pj.rows?.[0];
  if (!project) {
    console.warn(`[nextCalls] resolve: project not found ws=${workspaceName} pj=${projectName}`);
    return null;
  }

  // candidates (stateful)
  const ef = await statefulDb.query(
    `SELECT ef.id,
            ef.endpoint_id       AS origin_id,
            e.path,
            e.method
       FROM endpoints_ful ef
       JOIN endpoints e ON e.id = ef.endpoint_id
      WHERE ef.is_active = TRUE
        AND UPPER(e.method) = $1
        AND e.path = $2`,
    [method, logicalPath]
  );
  const candidates = ef.rows || [];
  if (!candidates.length) {
    console.warn(`[nextCalls] resolve: no stateful candidates method=${method} path=${logicalPath}`);
    return null;
  }

  // choose candidate by ws + project
  for (const ep of candidates) {
    const chk = await statelessDb.query(
      `SELECT 1
         FROM endpoints e
         JOIN folders f ON f.id = e.folder_id
         JOIN projects p ON p.id = f.project_id
         JOIN workspaces w ON w.id = p.workspace_id
        WHERE e.id = $1
          AND LOWER(p.name)=LOWER($2)
          AND LOWER(w.name)=LOWER($3)
        LIMIT 1`,
      [ep.origin_id, projectName, workspaceName]
    );
    if (chk.rows?.[0]) {
      console.log(`[nextCalls] resolve ✓ endpointId=${ep.id} originId=${ep.origin_id}`);
      return {
        method,
        workspaceName,
        projectName,
        projectId: project.id,
        endpointId: ep.id,
        originId: ep.origin_id,
        isStateful: true,
        logicalPath,
        basePath: ep.path,
        subPath: "",
      };
    }
  }

  console.warn(`[nextCalls] resolve: no candidate matched workspace/project`);
  return null;
}

async function persistNextCallLog(statelessDb, callRes, meta) {
  try {
    // build full path cho log:
    // - nếu là external URL: giữ nguyên (http/https)
    // - nếu là internal: /workspace/project/path
    let requestPath = meta.path || "";
    if (requestPath && !/^https?:\/\//i.test(requestPath)) {
      const ws = meta.workspaceName;
      const pj = meta.projectName;
      if (ws && pj) {
        const cleanPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
        requestPath = `/${ws}/${pj}${cleanPath}`;
      }
    }

    console.log(`[nextCalls] log persist → method=${meta.method} path=${requestPath} status=${callRes.status} parentLogId=${meta.parentLogId ?? "null"}`);

    const headersMeta = {
      __nextcall: {
        parent_log_id: meta.parentLogId ?? null,
        next_call_name: meta.nextCallName || null,
        is_nextcall: true,
      },
    };

    // --- Normalize response body để luôn là JSON ---
    let safeResponseBody = callRes.body;
    if (typeof safeResponseBody === "string") {
      try {
        safeResponseBody = { text: safeResponseBody };
      } catch {
        safeResponseBody = { text: String(safeResponseBody) };
      }
    }

    const inserted = await statelessDb.query(
      `INSERT INTO project_request_logs
     (project_id, endpoint_id, endpoint_response_id, user_id,
      stateful_endpoint_id, stateful_endpoint_response_id,
      request_method, request_path, request_headers, request_body,
      response_status_code, response_body, ip_address, latency_ms)
   VALUES
     ($1,$2,$3,$4, $5,$6, $7,$8,$9,$10, $11,$12,$13,$14)
   RETURNING id`,
      [
        meta.projectId ?? null,
        meta.originId ?? null,
        null,
        meta.userId ?? null,
        meta.statefulId ?? null,
        null,
        meta.method,
        requestPath, // 👈 dùng path đã chuẩn hóa
        headersMeta,
        meta.payload || {},
        callRes.status,
        safeResponseBody,
        null,
        Date.now() - (meta.started || Date.now()),
      ]
    );

    const logId = inserted?.rows?.[0]?.id || null;
    console.log(`[nextCalls] log id=${logId ?? "null"}`);
  } catch (e) {
    console.error("[nextCalls] log persist error:", e?.message || e);
  }
}

/* ========================================
 * Core: run sequential nextCalls (non-recursive)
 * ====================================== */
async function runNextCalls(plan, rootCtx = {}, options = {}) {
  let prev = null;
  const history = Array.isArray(rootCtx.history) ? [...rootCtx.history] : [];
  console.log(`[nextCalls] start: steps=${plan.length} rootStatus=${rootCtx?.res?.status}`);

  if (options?.suppressNextCalls || rootCtx?.flags?.suppressNextCalls) {
    console.log("[nextCalls] suppressed by options/flags");
    return true;
  }

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    console.log(`[nextCalls] step #${i + 1}/${plan.length} name=${step.name ?? ""}`);

    try {
      const ok = checkCondition(step.condition, { root: rootCtx, prev });
      console.log(`[nextCalls] condition → ${ok} cond=${JSON.stringify(step.condition)} prevStatus=${prev?.status ?? "n/a"} rootStatus=${rootCtx?.res?.status}`);
      if (!ok) {
        prev = null;
        continue;
      }

      // ============ NEW: detect proxy external ==============
      const externalUrl = step?.target?.externalUrl;
      const isExternal = !!externalUrl;

      // =====================================================

      // Nếu là external proxy -> dùng fetch
      // Nếu là external proxy -> dùng fetch
      if (isExternal) {
        const url = externalUrl;
        const method = (step?.target?.method || step?.method || "GET").toUpperCase();
        const ctx = { root: rootCtx, prev, history };
        const payload = renderTemplate(step.payload?.template ?? {}, ctx);
        const headersTpl = renderTemplate(step.headers?.template ?? {}, ctx);

        const rootHeaders = rootCtx?.request?.headers_lc || rootCtx?.request?.headers || {};
        const mergedHeaders = mergeHeadersCI(rootHeaders, headersTpl || {});

        const currentUser = options.user || rootCtx.user || null;
        if (!mergedHeaders["content-type"]) mergedHeaders["content-type"] = "application/json";
        if (currentUser?.id) mergedHeaders["x-mock-user-id"] = currentUser.id;

        console.log(`[nextCalls] proxy → ${method} ${url} body=${JSON.stringify(payload)}`);
        try {
          const started = Date.now();
          const res = await fetch(url, {
            method,
            headers: mergedHeaders,
            body: method === "GET" ? undefined : JSON.stringify(payload),
          });
          const text = await res.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }

          console.log(`[nextCalls] proxy result ← ${res.status} ${url}`);

          const callRes = { status: res.status, body };

          // lưu log nếu cần
          if (step.log?.persist) {
            await persistNextCallLog(options.statelessDb, callRes, {
              parentLogId: rootCtx.log?.id ?? null,
              nextCallName: step.name,
              projectId: rootCtx.projectId ?? null, // cùng project với call gốc
              originId: null, // external → không có endpoint_id
              statefulId: null,
              method,
              path: url, // 👈 external: full URL
              workspaceName: rootCtx.workspaceName,
              projectName: rootCtx.projectName,
              started,
              payload,
              userId: step.auth?.mode === "same-user" ? options.user?.id || rootCtx.user?.id || null : null,
            });
          }

          // push history để step sau có thể dùng {{N.response.body}}
          history.push({
            request: { body: payload, headers: mergedHeaders },
            response: { body },
            res: { status: res.status, body },
            status: res.status,
          });

          prev = callRes;
          continue; // sang step tiếp theo
        } catch (err) {
          console.error(`[nextCalls] proxy error for ${url}:`, err.message || err);
          prev = null;
          continue;
        }
      }

      // ============ INTERNAL STATEFUL CALL (giữ nguyên logic cũ) ==============
      const target = await resolveTargetEndpoint(step, {
        defaultWorkspace: rootCtx.workspaceName,
        defaultProject: rootCtx.projectName,
        statelessDb: options.statelessDb,
        statefulDb: options.statefulDb,
      });
      if (!target?.isStateful) {
        console.warn("[nextCalls] skip: target not resolved/stateful");
        prev = null;
        continue;
      }

      console.log(`[nextCalls] target → ${target.method} /${target.workspaceName}/${target.projectName}${target.logicalPath} (endpointId=${target.endpointId})`);

      const currentCtxForRender = { root: rootCtx, prev, history };
      const payload = renderTemplate(step.payload?.template ?? {}, currentCtxForRender);
      const headersTpl = renderTemplate(step.headers?.template ?? {}, currentCtxForRender);

      let renderedPath = renderStringTemplate(target.logicalPath || "", currentCtxForRender);
      const method = (target.method || "GET").toUpperCase();

      if (step.delayMs) await sleep(step.delayMs);
      // headers gốc từ API root (đã lowercase ở statefulHandler)
      const rootHeaders = rootCtx?.request?.headers_lc || rootCtx?.request?.headers || {};

      // kế thừa tất cả header root + override bởi step.headers
      const headersWithUser = mergeHeadersCI(rootHeaders, headersTpl || {});

      // bắt buộc content-type + user
      if (!headersWithUser["content-type"]) headersWithUser["content-type"] = "application/json";

      const currentUser = options.user || rootCtx.user || null;
      if (currentUser?.id) headersWithUser["x-mock-user-id"] = currentUser.id;

      if (!headersWithUser["content-type"]) headersWithUser["content-type"] = "application/json";
      if (currentUser?.id) headersWithUser["x-mock-user-id"] = currentUser.id;

      const reqLike = {
        method,
        headers: headersWithUser,
        body: payload,
        baseUrl: `/${target.workspaceName}/${target.projectName}`,
        originalUrl: `/${target.workspaceName}/${target.projectName}${renderedPath}`,
        db: { stateless: options.statelessDb, stateful: options.statefulDb },
        universal: {
          method,
          workspaceName: target.workspaceName,
          projectName: target.projectName,
          projectId: target.projectId,
          basePath: target.logicalPath,
          rawPath: target.logicalPath,
          subPath: target.subPath || "",
          statefulId: target.endpointId,
          statelessId: null,
        },
        flags: { isNextCall: true, suppressNextCalls: true },
        user: currentUser,
        res: { locals: {} },
      };

      const started = Date.now();
      const resCapture = createMemoryResponder();
      const statefulHandler = require("./statefulHandler");
      await statefulHandler(reqLike, resCapture);
      const callRes = resCapture.toJSON();
      console.log(`[nextCalls] ← status=${callRes.status}`);

      // trước khi gọi persistNextCallLog, thêm:
      const projectIdForLog = rootCtx.projectId ?? target.projectId;
      const originIdForLog = rootCtx.originId ?? target.originId;
      const statefulIdForLog = rootCtx.statefulId ?? target.endpointId;

      if (step.log?.persist) {
        await persistNextCallLog(options.statelessDb, callRes, {
          parentLogId: rootCtx.log?.id ?? null,
          nextCallName: step.name,

          // 🔧 dùng project/endpoint của CHÍNH endpoint target
          projectId: target.projectId, // vd: 23 (pj8)
          originId: target.originId, // vd: 94
          statefulId: target.endpointId, // vd: 56

          method,
          path: renderedPath, // "/next3"
          workspaceName: target.workspaceName,
          projectName: target.projectName,
          started,
          payload,
          userId: step.auth?.mode === "same-user" ? options.user?.id || rootCtx.user?.id || null : null,
        });
      }

      history.push({
        request: { body: payload, headers: headersWithUser },
        response: { body: callRes.body },
        res: { status: callRes.status, body: callRes.body },
        status: callRes.status,
      });

      prev = callRes;
      // ========================================================================
    } catch (err) {
      console.error("[nextCalls] runNextCalls error:", err?.message || err);
      prev = null;
    }
  }

  console.log("[nextCalls] done");
}

/* ========================================
 * Internal testing route
 * ====================================== */
router.post("/__nextcall/execute", async (req, res) => {
  const { plan = [], rootCtx = {}, options = {} } = req.body || {};
  try {
    await runNextCalls(buildPlanFromAdvancedConfig(plan), rootCtx, options);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
module.exports.runNextCalls = runNextCalls;
module.exports.buildPlanFromAdvancedConfig = buildPlanFromAdvancedConfig;
