// src/routes/universalHandler.js
const express = require("express");
const router = express.Router();

const statefulHandler = require("./statefulHandler");
const statelessHandler = require("./mock.routes");

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
    const { base: baseCandidate, id: idCandidate } = splitBaseAndNumericId(normPath);

    const candidates =
      idCandidate !== null && baseCandidate !== normPath
        ? [normPath, baseCandidate]
        : [normPath];

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
    const { rows: epRows } = await req.db.stateless.query(
      `SELECT id, path, method, is_stateful, is_active
         FROM endpoints
        WHERE UPPER(method) = $1
          AND path = ANY($2)`,
      [method, candidates]
    );

    if (!epRows.length) {
      return res.status(404).json({ message: "Endpoint not found", detail: { method, path: normPath } });
    }

    const matchedStateless =
      epRows.find((r) => normalizePath(r.path) === normPath) ||
      epRows.find((r) => normalizePath(r.path) === baseCandidate);

    if (!matchedStateless) {
      return res.status(404).json({ message: "Endpoint not found", detail: { method, path: normPath } });
    }

    const matchedPath = normalizePath(matchedStateless.path);
    const idInUrl = matchedPath !== normPath ? idCandidate : null;

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
      };

      const mode = matchedStateless.is_stateful ? "stateful" : "stateless";
      cacheSet(ck, { mode, meta });
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
