// src/routes/nextcallRouter.js
const express = require("express");
const router = express.Router();
const logSvc = require("../services/project_request_log.service");

console.log("[nextCalls] router loaded");

/* ========================================
 * Helpers (gói trong 1 file)
 * ====================================== */
function get(obj, path) {
  return path?.split(".").reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
}

/**
 * renderTemplate:
 * - tpl: object/array/string containing {{...}} placeholders
 * - ctx: { root, prev } where root = original root context (may contain req/res),
 *        prev = previous step context (we attach prev.request.body and prev.body after each step)
 *
 * Support access patterns:
 *  - {{request.body.foo}}  -> tries prev.request first, then root.request
 *  - {{response.body.foo}} -> tries prev.response (prev.body) first, then root.response (root.res)
 *  - {{root.res.status}} or {{prev.status}}
 */
function renderTemplate(tpl, ctx = {}) {
  if (!tpl || typeof tpl !== "object") return tpl;

  // Build convenient scope: allow templates to use "request" and "response" directly.
  // request: prefer prev.request, fallback to root.req / root.request
  // response: prefer prev.response (prev.body), fallback to root.res / root.response
  const scope = {
    root: ctx.root,
    prev: ctx.prev,
    request: ctx.prev?.request ?? ctx.root?.req ?? ctx.root?.request ?? {},
    response: ctx.prev?.response ?? ctx.root?.res ?? ctx.root?.response ?? {},
  };

  const walk = (v) => {
    if (typeof v === "string") {
      return v.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
        const path = expr.trim();
        const val = get(scope, path);

        if (val === undefined || val === null) return "";

        // Giữ nguyên kiểu nếu là number hoặc boolean
        if (typeof val === "number" || typeof val === "boolean") return val;

        // Nếu là chuỗi số, convert thành số thật
        if (typeof val === "string" && /^[0-9]+$/.test(val)) return Number(val);

        // Mặc định trả về string
        return String(val);
      });
    } else if (Array.isArray(v)) {
      return v.map(walk);
    } else if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(tpl);
}

/**
 * renderStringTemplate:
 * - For rendering path strings that may contain {{...}} placeholders.
 * - ctx: same shape as renderTemplate expects.
 */
function renderStringTemplate(tpl, ctx = {}) {
  if (!tpl || typeof tpl !== "string") return tpl;
  const scope = {
    root: ctx.root,
    prev: ctx.prev,
    request: ctx.prev?.request ?? ctx.root?.req ?? ctx.root?.request ?? {},
    response: ctx.prev?.response ?? ctx.root?.res ?? ctx.root?.response ?? {},
  };
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const path = expr.trim();
    const val = get(scope, path);
    return typeof val === "undefined" ? "" : String(val);
  });
}

function checkCondition(cond, { root, prev }) {
  // Shorthand number / boolean
  if (typeof cond === "number") {
    const base = prev && typeof prev.status !== "undefined" ? prev.status : root?.res?.status;
    console.log(`[nextCalls] cond-eval(shorthand-number) use=${prev ? "prev.status" : "root.status"} actual=${base} expect=${cond}`);
    return Number(base) === Number(cond);
  }
  if (typeof cond === "boolean") {
    console.log(`[nextCalls] cond-eval(shorthand-bool) value=${cond}`);
    return cond;
  }

  if (!cond) return true; // null/undefined => không ràng buộc

  // Object condition: mặc định source = 'prev' nếu có prev, ngược lại 'root'
  const source = cond.source ?? (prev ? "prev" : "root");
  const src = source === "prev" ? prev : root?.res;
  const val = get(src, cond.path); // ví dụ "status" hoặc "body.code"
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

function buildPlanFromAdvancedConfig(nextCalls = []) {
  const arr = Array.isArray(nextCalls) ? nextCalls : [];
  const plan = arr.map((s) => {
    let workspace = null,
      project = null,
      logicalPath = null;
    if (typeof s?.target_endpoint === "string") {
      const m = s.target_endpoint.match(/^\/([^/]+)\/([^/]+)(\/.*)$/);
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
      },
      payload: { template: s?.body || {} }, // map body -> payload.template
      headers: { template: s?.headers || {} },
      condition: typeof s?.condition !== "undefined" ? s.condition : null, // 200 shorthand OK
      delayMs: Number(s?.delayMs) || 0,
      timeoutMs: Number(s?.timeoutMs) || 0,
      onError: s?.onError === "halt" ? "halt" : "continue",
      log: { persist: s?.log?.persist !== false, notify: !!s?.log?.notify },
      auth: { mode: s?.auth?.mode || "same-user" }, // "same-user" | "none" | "service-user"
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

  // 1) Project ở stateless (để có projectId cho log)
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

  // 2) DB mới: JOIN endpoints để lọc theo method/path
  const ef = await statefulDb.query(
    `SELECT ef.id,
            ef.endpoint_id       AS origin_id,  -- map về endpoints.id để check tenant
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

  // 3) Chọn đúng candidate bằng origin_id ở stateless
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
        endpointId: ep.id, // endpoints_ful.id
        originId: ep.origin_id, // endpoints.id (stateless)
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
    console.log(`[nextCalls] log persist → method=${meta.method} path=${meta.path} status=${callRes.status} parentLogId=${meta.parentLogId ?? "null"}`);

    const headersMeta = {
      __nextcall: {
        parent_log_id: meta.parentLogId ?? null,
        next_call_name: meta.nextCallName || null,
        is_nextcall: true,
      },
    };

    const inserted = await statelessDb.query(
      `INSERT INTO project_request_logs
         (project_id, endpoint_id, endpoint_response_id, user_id,
          stateful_endpoint_id, stateful_endpoint_response_id,
          request_method, request_path, request_headers, request_body,
          response_status_code, response_body, ip_address, latency_ms)
       VALUES
         ($1,$2,$3,$4, $5,$6, $7,$8,$9,$10, $11,$12,$13,$14)
       RETURNING id`,
      [meta.projectId ?? null, meta.originId ?? null, null, meta.userId ?? null, meta.statefulId ?? null, null, meta.method, meta.path, headersMeta, meta.payload || {}, callRes.status, callRes.body, null, Date.now() - (meta.started || Date.now())]
    );

    const logId = inserted?.rows?.[0]?.id || null;
    console.log(`[nextCalls] log id=${logId ?? "null"}`);
  } catch (e) {
    console.error("[nextCalls] log persist error:", e?.message || e);
  }
}

/* ========================================
 * Core: chạy tuần tự mảng nextCalls (không đệ quy)
 * ====================================== */
async function runNextCalls(plan, rootCtx = {}, options = {}) {
  let prev = null;
  console.log(`[nextCalls] start: steps=${plan.length} rootStatus=${rootCtx?.res?.status}`);

  // protect: if caller asked to suppress next calls, return early
  if (options?.suppressNextCalls || rootCtx?.flags?.suppressNextCalls) {
    console.log("[nextCalls] suppressed by options/flags");
    return true;
  }

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    console.log(`[nextCalls] step #${i + 1}/${plan.length} name=${step.name ?? ""}`);

    try {
      // 1) điều kiện (check using rootCtx and prev)
      const ok = checkCondition(step.condition, { root: rootCtx, prev });
      console.log(`[nextCalls] condition → ${ok} cond=${JSON.stringify(step.condition)} prevStatus=${prev?.status ?? "n/a"} rootStatus=${rootCtx?.res?.status}`);
      if (!ok) {
        prev = null; // skip but clear prev so subsequent steps default to root
        continue;
      }

      // 2) resolve target
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

      // 3) render payload/headers using current context (rootCtx + prev)
      const currentCtxForRender = { root: rootCtx, prev };
      const payload = renderTemplate(step.payload?.template ?? {}, currentCtxForRender);
      const headers = renderTemplate(step.headers?.template ?? {}, currentCtxForRender);

      // 3.1) render logicalPath string (supports templates inside path)
      let renderedPath = renderStringTemplate(target.logicalPath || "", currentCtxForRender);

      // 3.2) If method is PUT/DELETE and path still has no id, try to find id from payload or prev
      const method = (target.method || "GET").toUpperCase();

      // helper: attempt to find an id from payload or prev bodies (common shapes)
      const findIdFrom = (candidatePayload, prevObj) => {
        // Try direct id in payload
        if (candidatePayload && (candidatePayload.id || candidatePayload._id)) return candidatePayload.id ?? candidatePayload._id;
        // Try prev.response body common shapes
        const b = prevObj?.body ?? prevObj?.response ?? null;
        if (!b) return null;
        if (typeof b === "object") {
          if (b.id) return b.id;
          if (b._id) return b._id;
          // data_current (array or object with array)
          if (Array.isArray(b?.data_current) && b.data_current.length) {
            const last = b.data_current[b.data_current.length - 1];
            if (last && (last.id || last._id)) return last.id ?? last._id;
          }
          if (Array.isArray(b?.data) && b.data.length) {
            const last = b.data[b.data.length - 1];
            if (last && (last.id || last._id)) return last.id ?? last._id;
          }
          // if response itself is array
          if (Array.isArray(b) && b.length) {
            const last = b[b.length - 1];
            if (last && (last.id || last._id)) return last.id ?? last._id;
          }
        }
        return null;
      };

      // try to detect id from rendered payload or prev
      let idFromPayload = findIdFrom(payload, prev);
      let idFromPrev = findIdFrom({}, prev); // only prev body
      const chosenId = idFromPayload ?? idFromPrev ?? null;

      // If path contains explicit placeholder like /:id, the resolveTargetEndpoint removed /:id earlier.
      // But if the logicalPath included template like {{request.body.id}} we've already rendered it above.
      // If still no id and method requires it, append chosenId to path if exists.
      if ((method === "PUT" || method === "DELETE") && (!renderedPath || !/\/[^/]*\d+/.test(renderedPath))) {
        // if renderedPath doesn't include an id-like segment, append id
        if (chosenId) {
          if (!renderedPath.endsWith("/")) renderedPath = `${renderedPath}/${chosenId}`;
          else renderedPath = `${renderedPath}${chosenId}`;
        } else {
          // no id found — we still proceed but log warning
          console.warn(`[nextCalls] no id found for ${method} ${renderedPath}; attempt will proceed without explicit id`);
        }
      }

      console.log(`[nextCalls] → invoke ${method} ${renderedPath} body=${JSON.stringify(payload)}`);

      if (step.delayMs) await sleep(step.delayMs);

      // 4) gọi statefulHandler nội bộ, chặn nextCalls ở endpoint con
      // 3. Tạo request giả cho statefulHandler
      const currentUser = options.user || rootCtx.user || null;
      const headersWithUser = {
        ...headers,
        "Content-Type": "application/json",
      };

      // Nếu user có id, truyền vào để statefulHandler.requireAuth() đọc được
      if (currentUser?.id) {
        headersWithUser["x-mock-user-id"] = currentUser.id;
      }

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
      // lazy-require để tránh vòng tròn require
      const statefulHandler = require("./statefulHandler");
      if (typeof statefulHandler !== "function") {
        console.error("[nextCalls] FATAL: statefulHandler not loaded as a function");
        throw new Error("statefulHandler not a function");
      }
      await statefulHandler(reqLike, resCapture);
      const callRes = resCapture.toJSON();
      console.log(`[nextCalls] ← status=${callRes.status}`);

      // persist log if requested
      if (step.log?.persist) {
        await persistNextCallLog(options.statelessDb, callRes, {
          parentLogId: rootCtx.log?.id, // có thể null nếu bạn chưa lấy được
          nextCallName: step.name,
          projectId: target.projectId,
          originId: target.originId,
          statefulId: target.endpointId,
          method,
          path: renderedPath,
          started,
          payload,
          userId: step.auth?.mode === "same-user" ? options.user?.id || rootCtx.user?.id || null : null,
        });
      }

      // Update prev to include both response and the request that produced it
      prev = {
        status: callRes.status,
        body: callRes.body,
        headers: callRes.headers,
        request: { body: payload },
        response: callRes.body, // alias convenience
      };
    } catch (e) {
      console.error("[nextCalls] step error:", e?.message || e);
      if (step.onError === "halt") break;
      prev = null;
    }
  }
  console.log("[nextCalls] done");
  return true;
}

/* ========================================
 * (Optional) HTTP route nội bộ để test nhanh qua Postman
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
