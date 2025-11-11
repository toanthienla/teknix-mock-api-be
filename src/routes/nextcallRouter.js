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
      logicalPath = null;

    let raw = typeof s?.target_endpoint === "string" ? s.target_endpoint : "";

    // Accept full URL
    if (/^https?:\/\//i.test(raw)) {
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
      },
      payload: { template: s?.body || {} },
      headers: { template: s?.headers || {} },
      condition: typeof s?.condition !== "undefined" ? s.condition : null,
      delayMs: Number(s?.delayMs ?? s?.delay_ms) || 0, // <--- NEW
      timeoutMs: Number(s?.timeoutMs ?? s?.timeout_ms) || 0, // optional
      onError: s?.onError === "halt" ? "halt" : "continue",
      log: { persist: s?.log?.persist !== false, notify: !!s?.log?.notify },
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
 * Core: run sequential nextCalls (non-recursive)
 * ====================================== */
async function runNextCalls(plan, rootCtx = {}, options = {}) {
  let prev = null;
  // --- NEW: history support. seed with root (#1)
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
      const headers = renderTemplate(step.headers?.template ?? {}, currentCtxForRender);

      let renderedPath = renderStringTemplate(target.logicalPath || "", currentCtxForRender);
      const method = (target.method || "GET").toUpperCase();

      // try to find id for PUT/DELETE if path lacks id (heuristic)
      const findIdFrom = (candidatePayload, prevObj) => {
        if (candidatePayload && (candidatePayload.id || candidatePayload._id)) return candidatePayload.id ?? candidatePayload._id;
        const b = prevObj?.body ?? prevObj?.response ?? null;
        if (!b) return null;
        if (typeof b === "object") {
          if (b.id) return b.id;
          if (b._id) return b._id;
          if (Array.isArray(b?.data_current) && b.data_current.length) {
            const last = b.data_current[b.data_current.length - 1];
            if (last && (last.id || last._id)) return last.id ?? last._id;
          }
          if (Array.isArray(b?.data) && b.data.length) {
            const last = b.data[b.data.length - 1];
            if (last && (last.id || last._id)) return last.id ?? last._id;
          }
          if (Array.isArray(b) && b.length) {
            const last = b[b.length - 1];
            if (last && (last.id || last._id)) return last.id ?? last._id;
          }
        }
        return null;
      };

      let idFromPayload = findIdFrom(payload, prev);
      let idFromPrev = findIdFrom({}, prev);
      const chosenId = idFromPayload ?? idFromPrev ?? null;

      if ((method === "PUT" || method === "DELETE") && (!renderedPath || !/\/[^/]*\d+/.test(renderedPath))) {
        if (chosenId) {
          if (!renderedPath.endsWith("/")) renderedPath = `${renderedPath}/${chosenId}`;
          else renderedPath = `${renderedPath}${chosenId}`;
        } else {
          console.warn(`[nextCalls] no id found for ${method} ${renderedPath}; attempt will proceed without explicit id`);
        }
      }

      console.log(`[nextCalls] → invoke ${method} ${renderedPath} body=${JSON.stringify(payload)}`);

      if (step.delayMs) await sleep(step.delayMs); // --- NEW ---

      // build internal req for stateful handler
      const currentUser = options.user || rootCtx.user || null;
      const headersWithUser = {
        ...(headers || {}),
        "Content-Type": "application/json",
      };
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
      if (typeof statefulHandler !== "function") {
        console.error("[nextCalls] FATAL: statefulHandler not loaded as a function");
        throw new Error("statefulHandler not a function");
      }
      await statefulHandler(reqLike, resCapture);
      const callRes = resCapture.toJSON();
      console.log(`[nextCalls] ← status=${callRes.status}`);

      // persist nextcall log (single-source of truth for next-call logs)
      if (step.log?.persist) {
        await persistNextCallLog(options.statelessDb, callRes, {
          parentLogId: rootCtx.log?.id,
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

      // --- NEW: push into history so later steps can reference {{N.request...}}/{{N.response...}}
      history.push({
        request: { body: payload, headers: headersWithUser },
        response: { body: callRes.body },
        res: { status: callRes.status, body: callRes.body },
        status: callRes.status,
      });

      // prev (back-compat single-step access)
      prev = {
        status: callRes.status,
        body: callRes.body,
        headers: callRes.headers,
        request: { body: payload },
        response: callRes.body,
        res: { status: callRes.status, body: callRes.body },
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
