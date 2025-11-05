// src/routes/universalHandler.js
const express = require("express");
// ⚠️ Quan trọng: nhận được :workspace/:project từ router cha
const router = express.Router({ mergeParams: true });

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
    // ——— Resolve theo mount `/:workspace/:project` ———
    // Ưu tiên lấy từ params; nếu (hiếm) thiếu, bóc từ baseUrl.
    let workspaceName = req.params?.workspace;
    let projectName = req.params?.project;
    if (!workspaceName || !projectName) {
      const segs = String(req.baseUrl || "")
        .split("/")
        .filter(Boolean);
      // baseUrl dạng: "/WP_2/pj3"
      workspaceName = workspaceName || segs[0];
      projectName = projectName || segs[1];
    }
    const rawPath = (req.baseUrl ? req.baseUrl + (req.path || "") : req.originalUrl || req.path || "/").split("?")[0];
    const normPath = normalizePath(rawPath);
    const pathForLookup = normalizePath(req.path || "/"); // phần sau prefix để dò `endpoints.path`

    // Tìm projectId theo cặp tên (1 lần, dùng cho cả stateful/stateless ở dưới)
    let projectId = null;
    try {
      const { rows: prj } = await req.db.stateless.query(
        `SELECT p.id
           FROM projects p
           JOIN workspaces w ON w.id = p.workspace_id
          WHERE w.name = $1 AND p.name = $2
          LIMIT 1`,
        [workspaceName, projectName]
      );
      projectId = prj?.[0]?.id ?? null;
    } catch (e) {
      console.warn("[universal] resolve projectId failed:", e?.message || e);
    }
    const { base: baseCandidate, id: idCandidate } = splitBaseAndNumericId(pathForLookup);

    const candidates = idCandidate !== null && baseCandidate !== pathForLookup ? [pathForLookup, baseCandidate] : [pathForLookup];

    const ck = cacheKeyOf(method, normPath);
    const cached = cacheGet(ck);
    if (cached) {
      try {
        console.log("[universal] cache hit", cached);
      } catch {}
      // 🔁 Revalidate nếu cache đang nói "stateless"
      if (cached.mode === "stateless" && cached.meta?.statelessId) {
        try {
          const { rows } = await req.db.stateful.query(
            `SELECT ef.id, ef.is_active 
               FROM endpoints_ful ef
              WHERE ef.endpoint_id = $1
              LIMIT 1`,
            [cached.meta.statelessId]
          );
          if (rows[0]?.id && rows[0]?.is_active === true) {
            // nâng cấp lên stateful ngay lập tức
            const upgraded = {
              ...cached,
              mode: "stateful",
              meta: { ...cached.meta, statefulId: rows[0].id },
            };
            cacheSet(ck, upgraded);
            req.universal = upgraded.meta;
            res.setHeader("x-universal-mode", "stateful(revalidated)");
            try {
              console.log("[universal] cache upgraded -> stateful", upgraded);
            } catch {}
            return runHandler(statefulHandler, req, res, next);
          }
        } catch (e) {
          console.warn("[universal] revalidate failed:", e?.message || e);
        }
      }
      // giữ nguyên cache cũ nếu không “nâng cấp” được
      req.universal = cached.meta;
      res.setHeader("x-universal-mode", cached.mode);
      try {
        console.log("[universal] cache route", { mode: cached.mode });
      } catch {}
      return runHandler(cached.mode === "stateless" ? statelessHandler : statefulHandler, req, res, next);
    }

    // 🔹 Tìm endpoint trong DB stateless
    //console.log(`[universal] lookup method=${method} normPath=${normPath} pathForLookup=${pathForLookup} candidates=${JSON.stringify(candidates)}`);

    // Fetch all endpoints for the method, then match in JS using path-to-regexp
    const { rows: allRows } = await req.db.stateless.query(
      `SELECT id, path, method, is_stateful, is_active
         FROM endpoints
        WHERE UPPER(method) = $1`,
      [method]
    );
    //console.log(`[universal] allRows.count=${allRows.length}`);

    // Filter rows whose stored path pattern matches the pathForLookup or baseCandidate
    const candidateRows = allRows.filter((r) => {
      try {
        let pattern = normalizePath(r.path);

        // 🔹 Nếu endpoint KHÔNG có param hoặc wildcard, cho phép match sâu hơn (vd: /a/b match /a/b/c/d)
        if (!pattern.includes(":") && !pattern.includes("*")) {
          // thêm pattern mở rộng tự động
          pattern = pattern.endsWith("/") ? pattern + ":rest(.*)?" : pattern + "/:rest(.*)?";
        }

        const fn = match(pattern, { decode: decodeURIComponent, strict: false, end: false });
        const matched = Boolean(fn(pathForLookup)) || Boolean(fn(baseCandidate));

        if (matched) {
          //console.log(`✅ matched pattern=${pattern} for path=${pathForLookup}`);
        }

        return matched;
      } catch (e) {
        console.error(`❌ match error for path=${r.path}:`, e.message);
        return false;
      }
    });

    //console.log(`[universal] candidateRows.length=${candidateRows.length} paths=${JSON.stringify(candidateRows.map((r) => r.path))}`);

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
      // a) Tìm endpoint ở DB stateful — map qua endpoint_id (JOIN endpoints khi cần fallback)
      let st = await req.db.stateful.query(
        `SELECT ef.id, ef.is_active
           FROM endpoints_ful ef
          WHERE ef.endpoint_id = $1
          LIMIT 1`,
        [matchedStateless.id]
      );
      if (!st.rows[0]) {
        st = await req.db.stateful.query(
          `SELECT ef.id, ef.is_active
             FROM endpoints_ful ef
             JOIN endpoints e ON e.id = ef.endpoint_id
            WHERE UPPER(e.method) = $1
              AND e.path = $2
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

      // ✅ Tạo meta (dùng đúng params + subPath đã chuẩn hoá)
      const subPath = pathForLookup;
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
      cacheSet(ck, { mode, meta }); // ✅ cache đúng theo mode thực tế
      req.universal = meta;
      res.setHeader("x-universal-mode", mode);
      try {
        // console.log("[universal] decided", { mode, meta });
      } catch {}

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

    // ✅ Stateless (đã có prefix vì router mount sẵn): tạo meta chuẩn và chạy handler
    {
      const subPath = pathForLookup;
      const meta = {
        mode: "stateless",
        method,
        rawPath: normPath,
        basePath: matchedPath,
        idInUrl,
        statelessId: matchedStateless.id,
        projectId,
        workspaceName,
        projectName,
        subPath,
      };
      req.universal = meta;
      cacheSet(ck, { mode: "stateless", meta });
      res.setHeader("x-universal-mode", "stateless");
      try {
        console.log("[universal] decided", { mode: "stateless", meta });
      } catch {}
      return runHandler(statelessHandler, req, res, next);
    }
  } catch (err) {
    console.error("❌ universalHandler error:", err);
    res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

module.exports = router;
