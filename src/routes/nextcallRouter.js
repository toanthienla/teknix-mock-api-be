// src/routes/nextcallRouter.js
const express = require("express");
const router = express.Router();
const logSvc = require("../services/project_request_log.service");
const { onProjectLogInserted } = require("../services/notification.service");

console.log("[nextCalls] router loaded");

/* ========================================
 * Helpers (gói trong 1 file)
 * ====================================== */
function get(obj, path) {
  return path?.split(".").reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
}

function renderTemplate(tpl, ctx) {
  if (!tpl || typeof tpl !== "object") return tpl;
  // alias để hỗ trợ {{response.*}}
  const scope = { root: ctx.root, prev: ctx.prev, response: ctx.root?.res };

  const walk = (v) => {
    if (typeof v === "string") {
      return v.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
        const val = get(scope, expr.trim());
        return typeof val === "undefined" ? "" : String(val);
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

function renderTemplate(tpl, ctx) {
  if (!tpl || typeof tpl !== "object") return tpl;
  const scope = { root: ctx.root, prev: ctx.prev, response: ctx.root?.res }; // alias response

  const walk = (v) => {
    if (typeof v === "string") {
      return v.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
        const val = get(scope, expr.trim());
        return typeof val === "undefined" ? "" : String(val);
      });
    } else if (Array.isArray(v)) return v.map(walk);
    else if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(tpl);
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

  // 2) Candidates trong stateful theo method+path (KHÔNG JOIN folders)
  const ef = await statefulDb.query(
    `SELECT e.id, e.origin_id, e.path, e.method
       FROM endpoints_ful e
      WHERE e.is_active=TRUE AND e.method=$1 AND e.path=$2`,
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
    if (logId) {
      try {
        // Theo service của bạn; nếu khác chữ ký hãy dùng đúng phiên bản đang chạy
        await onProjectLogInserted(logId, statelessDb);
        console.log("[nextCalls] notify OK");
      } catch (e) {
        console.warn("[nextCalls] notify error:", e?.message || e);
      }
    }
  } catch (e) {
    console.error("[nextCalls] log persist error:", e?.message || e);
  }
}

/* ========================================
 * Core: chạy tuần tự mảng nextCalls (không đệ quy)
 * ====================================== */
async function runNextCalls(plan, rootCtx, options = {}) {
  let prev = null;
  console.log(`[nextCalls] start: steps=${plan.length} rootStatus=${rootCtx?.res?.status}`);

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    console.log(`[nextCalls] step #${i + 1}/${plan.length} name=${step.name ?? ""}`);

    try {
      // 1) điều kiện
      const ok = checkCondition(step.condition, { root: rootCtx, prev });
      console.log(`[nextCalls] condition → ${ok} cond=${JSON.stringify(step.condition)} prevStatus=${prev?.status ?? "n/a"} rootStatus=${rootCtx?.res?.status}`);
      if (!ok) {
        prev = null;
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

      // 3) render payload/headers
      const payload = renderTemplate(step.payload?.template, { root: rootCtx, prev });
      const headers = renderTemplate(step.headers?.template, { root: rootCtx, prev });
      console.log(`[nextCalls] → invoke ${target.method} ${target.logicalPath} body=${JSON.stringify(payload)}`);

      if (step.delayMs) await sleep(step.delayMs);

      // 4) gọi statefulHandler nội bộ, chặn nextCalls ở endpoint con
      const reqLike = {
        method: target.method,
        headers,
        body: payload,
        baseUrl: `/${target.workspaceName}/${target.projectName}`,
        originalUrl: `/${target.workspaceName}/${target.projectName}${target.logicalPath}`,
        db: { stateless: options.statelessDb, stateful: options.statefulDb },
        universal: {
          method: target.method,
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
        user: options.user || rootCtx.user || null,
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

      if (step.log?.persist) {
        await persistNextCallLog(options.statelessDb, callRes, {
          parentLogId: rootCtx.log?.id, // có thể null nếu bạn chưa lấy được
          nextCallName: step.name,
          projectId: target.projectId,
          originId: target.originId,
          statefulId: target.endpointId,
          method: target.method,
          path: target.logicalPath,
          started,
          payload,
          userId: step.auth?.mode === "same-user" ? options.user?.id || rootCtx.user?.id || null : null,
        });
      }
      prev = { status: callRes.status, body: callRes.body, headers: callRes.headers };
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
