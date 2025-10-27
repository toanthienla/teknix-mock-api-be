// src/routes/universalHandler.js
const express = require("express");
const router = express.Router();

const statefulHandler = require("./statefulHandler");
const statelessHandler = require("./mock.routes");
const { match } = require("path-to-regexp");

// ---------- small LRU cache to cut repeated lookups ----------
const CACHE = new Map();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 100;

const cacheKeyOf = (m, p) => `${m}:${p}`;
const cacheGet = (k) => {
  const v = CACHE.get(k);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL_MS) {
    CACHE.delete(k);
    return null;
  }
  // bump LRU
  CACHE.delete(k);
  CACHE.set(k, v);
  return v.data;
};
const cacheSet = (k, data) => {
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    CACHE.delete(oldest);
  }
  CACHE.set(k, { t: Date.now(), data });
};

// ---------- helpers ----------
function normalizePath(raw) {
  if (!raw) return "/";
  let p = raw.split("?")[0];
  try {
    p = decodeURIComponent(p);
  } catch {}
  p = p.replace(/\/{2,}/g, "/"); // nén nhiều slash
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p.startsWith("/")) p = "/" + p;
  return p || "/";
}

function splitBaseAndNumericId(path) {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return { base: "/", id: null };
  const last = segs[segs.length - 1];
  if (/^\d+$/.test(last)) {
    segs.pop();
    const base = "/" + segs.join("/");
    return { base: base || "/", id: Number(last) };
  }
  return { base: path, id: null };
}

function runHandler(handler, req, res, next) {
  if (handler && typeof handler.handle === "function") {
    return handler.handle(req, res, next);
  }
  if (typeof handler === "function") {
    return handler(req, res, next);
  }
  throw new Error("Invalid handler export");
}

// ---------- main ----------
router.use(async (req, res, next) => {
  try {
    const method = (req.method || "GET").toUpperCase();
    const normPath = normalizePath(req.path || req.originalUrl || "/");
    // If request contains workspace/project prefix (e.g. /<workspace>/<project>/...),
    // strip the first two segments for lookup in `endpoints` (which store paths without prefix).
    const segsAll = normPath.split("/").filter(Boolean);
    let prefixed = false;
    let workspaceName = null;
    let projectName = null;
    let pathForLookup = normPath; // default

    if (segsAll.length >= 3) {
      prefixed = true;
      workspaceName = segsAll[0];
      projectName = segsAll[1];
      pathForLookup = "/" + segsAll.slice(2).join("/");
    }

    const { base: baseCandidate, id: idCandidate } = splitBaseAndNumericId(pathForLookup);

    const candidates = idCandidate !== null && baseCandidate !== pathForLookup ? [pathForLookup, baseCandidate] : [pathForLookup];

    const ck = cacheKeyOf(method, normPath);
    const cached = cacheGet(ck);
    if (cached) {
      req.universal = cached.meta;
      if (cached.mode === "stateless") {
        return runHandler(statelessHandler, req, res, next);
      }
      return runHandler(statefulHandler, req, res, next);
    }

    // 🔹 Tìm endpoint trong DB stateless
    console.log(`[universal] lookup method=${method} normPath=${normPath} pathForLookup=${pathForLookup} candidates=${JSON.stringify(candidates)}`);

    // Fetch all endpoints for the method, then match in JS using path-to-regexp
    const { rows: allRows } = await req.db.stateless.query(
      `SELECT id, path, method, is_stateful, is_active
         FROM endpoints
        WHERE UPPER(method) = $1`,
      [method]
    );
    console.log(`[universal] allRows.count=${allRows.length}`);

    // Filter rows whose stored path pattern matches the pathForLookup or baseCandidate
    const candidateRows = allRows.filter((r) => {
      try {
        const fn = match(r.path, { decode: decodeURIComponent, strict: false, end: true });
        return Boolean(fn(pathForLookup)) || Boolean(fn(baseCandidate));
      } catch (e) {
        return false;
      }
    });
    console.log(`[universal] candidateRows.length=${candidateRows.length} paths=${JSON.stringify(candidateRows.map((r) => r.path))}`);

    if (!candidateRows.length) {
      return res.status(404).json({ message: "Endpoint not found", detail: { method, path: normPath } });
    }

    // Prefer exact match on pathForLookup, otherwise fall back to baseCandidate
    const matchedStateless = candidateRows.find((r) => normalizePath(r.path) === pathForLookup) || candidateRows.find((r) => normalizePath(r.path) === baseCandidate) || candidateRows[0];

    if (!matchedStateless) {
      return res.status(404).json({ message: "Endpoint not found", detail: { method, path: normPath } });
    }

    const matchedPath = normalizePath(matchedStateless.path);
    const idInUrl = matchedPath !== pathForLookup ? idCandidate : null;

    // ===============================
    // 🔹 Nếu endpoint là STATEFUL
    // ===============================
    if (matchedStateless.is_stateful === true) {
      // a) Tìm endpoint ở DB stateful
      let st = await req.db.stateful.query(
        `SELECT id, is_active
           FROM endpoints_ful
          WHERE origin_id = $1
          LIMIT 1`,
        [matchedStateless.id]
      );

      if (!st.rows[0]) {
        // fallback theo method+path
        st = await req.db.stateful.query(
          `SELECT id, is_active
             FROM endpoints_ful
            WHERE UPPER(method) = $1
              AND path = $2
            LIMIT 1`,
          [method, matchedPath]
        );
      }

      if (!st.rows[0]) {
        return res.status(500).json({
          message: "Stateful endpoint is enabled but not provisioned",
          detail: { method, path: matchedPath, origin_id: matchedStateless.id },
        });
      }

      if (st.rows[0].is_active === false) {
        return res.status(404).json({
          message: "Stateful endpoint is disabled",
          detail: { method, path: matchedPath },
        });
      }

      // ==========================
      // ✅ Lấy workspace/project/subPath
      // ==========================
      const segments = req.path.split("/").filter(Boolean);
      const workspaceName = segments[0];
      const projectName = segments[1];
      const subPath = "/" + segments.slice(2).join("/");

      // ✅ Truy DB để lấy projectId
      let projectId = null;
      try {
        const { rows } = await req.db.stateless.query(
          `SELECT p.id
             FROM projects p
             JOIN workspaces w ON p.workspace_id = w.id
            WHERE w.name = $1 AND p.name = $2
            LIMIT 1`,
          [workspaceName, projectName]
        );
        projectId = rows[0]?.id || null;
      } catch (err) {
        console.error("Error resolving projectId:", err);
      }

      // ✅ Tạo meta
      const meta = {
        method,
        basePath: matchedPath,
        rawPath: normPath,
        subPath,
        projectId,
        workspaceName,
        projectName,
        statelessId: matchedStateless.id,
        statefulId: st.rows[0]?.id || null,
        idInUrl, // ✅ thêm dòng này
      };

      const mode = matchedStateless.is_stateful ? "stateful" : "stateless";
      cacheSet(ck, { mode: "stateful", meta });
      req.universal = meta;

      if (mode === "stateless") {
        return runHandler(statelessHandler, req, res, next);
      }
      return runHandler(statefulHandler, req, res, next);
    }

    // ===============================
    // 🔹 Nếu endpoint là STATELESS
    // ===============================
    if (matchedStateless.is_active === false) {
      return res.status(404).json({
        message: "Stateless endpoint is disabled",
        detail: { method, path: matchedPath },
      });
    }

    // Detect optional workspace/project prefix for stateless endpoints.
    // If request path is like /:workspace/:project/..., resolve projectId and attach subPath so
    // downstream `mock.routes` can match using req.universal.subPath and req.universal.projectId.
    const segs = (req.path || "").split("/").filter(Boolean);
    if (segs.length >= 3) {
      const workspaceName = segs[0];
      const projectName = segs[1];
      const subPath = "/" + segs.slice(2).join("/");
      let projectId = null;
      try {
        const { rows } = await req.db.stateless.query(
          `SELECT p.id
             FROM projects p
             JOIN workspaces w ON p.workspace_id = w.id
            WHERE w.name = $1 AND p.name = $2
            LIMIT 1`,
          [workspaceName, projectName]
        );
        projectId = rows[0]?.id || null;
      } catch (err) {
        console.error("Error resolving projectId for stateless prefix:", err?.message || err);
      }

      const meta = {
        mode: "stateless",
        method,
        rawPath: normPath,
        basePath: matchedPath,
        idInUrl,
        statelessId: matchedStateless.id,
        // workspace/project context for downstream handlers
        projectId,
        workspaceName,
        projectName,
        subPath,
      };
      req.universal = meta;
      cacheSet(ck, { mode: "stateless", meta });
      return runHandler(statelessHandler, req, res, next);
    }

    // No workspace/project prefix — keep legacy behavior
    // If request had workspace/project prefix, include those fields and the subPath
    if (prefixed) {
      const subPath = pathForLookup;
      const meta = {
        mode: "stateless",
        method,
        rawPath: normPath,
        basePath: matchedPath,
        idInUrl,
        statelessId: matchedStateless.id,
        workspaceName,
        projectName,
        projectId: null, // resolved below (if possible)
        subPath,
      };

      // attempt to resolve projectId (best-effort)
      try {
        const { rows } = await req.db.stateless.query(
          `SELECT p.id
             FROM projects p
             JOIN workspaces w ON p.workspace_id = w.id
            WHERE w.name = $1 AND p.name = $2
            LIMIT 1`,
          [workspaceName, projectName]
        );
        meta.projectId = rows[0]?.id || null;
      } catch (err) {
        console.error("Error resolving projectId for stateless prefix:", err?.message || err);
      }

      req.universal = meta;
      cacheSet(ck, { mode: "stateless", meta });
      return runHandler(statelessHandler, req, res, next);
    }

    const meta = {
      mode: "stateless",
      method,
      rawPath: normPath,
      basePath: matchedPath,
      idInUrl,
      statelessId: matchedStateless.id,
    };
    req.universal = meta;
    cacheSet(ck, { mode: "stateless", meta });
    return runHandler(statelessHandler, req, res, next);
  } catch (err) {
    console.error("❌ universalHandler error:", err);
    res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

module.exports = router;
