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
  // express đã loại query, nhưng cứ chắc:
  let p = raw.split("?")[0];
  try {
    p = decodeURIComponent(p);
  } catch {}
  p = p.replace(/\/{2,}/g, "/"); // nén nhiều slash
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1); // bỏ slash cuối (trừ "/")
  if (!p.startsWith("/")) p = "/" + p;
  return p || "/";
}

// Cắt thử 1 segment cuối làm id (số). Nếu hợp lệ → trả base & id, ngược lại id=null.
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

// Gọi handler (router hoặc middleware hoặc object có .handle)
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

    // 1) Tìm endpoint ở DB stateless theo method + path (ưu tiên exact; nếu không, base khi có id)
    //    => Đây là "registry" quyết định chế độ.
    const candidates = idCandidate !== null && baseCandidate !== normPath ? [normPath, baseCandidate] : [normPath];

    // Cache theo path exact để các lần sau không hit DB
    const ck = cacheKeyOf(method, normPath);
    const cached = cacheGet(ck);
    if (cached) {
      req.universal = cached.meta;
      // Nếu stateless, chỉ chuyển subPath (/cat, /cat/1, ...)
      if (cached.mode === "stateless") {
        return runHandler(statelessHandler, req, res, next);
      }
      return runHandler(statefulHandler, req, res, next);
    }

    const { rows: epRows } = await req.db.stateless.query(
      `SELECT id, path, method, is_stateful, is_active
         FROM endpoints
        WHERE UPPER(method) = $1
          AND path = ANY($2)`,
      [method, candidates]
    );

    if (!epRows.length) {
      // Không có định nghĩa endpoint trong registry → 404
      return res.status(404).json({ message: "Endpoint not found", detail: { method, path: normPath } });
    }

    // Ưu tiên exact match, fallback base
    const matchedStateless = epRows.find((r) => normalizePath(r.path) === normPath) || epRows.find((r) => normalizePath(r.path) === baseCandidate);

    if (!matchedStateless) {
      return res.status(404).json({ message: "Endpoint not found", detail: { method, path: normPath } });
    }

    const matchedPath = normalizePath(matchedStateless.path);
    const idInUrl = matchedPath !== normPath ? idCandidate : null;

    // 2) Quyết định stateful/stateless dựa trên cờ
    if (matchedStateless.is_stateful === true) {
      // a) Xác minh endpoint ở DB stateful (ưu tiên theo origin_id)
      let st = await req.db.stateful.query(
        `SELECT id, is_active
           FROM endpoints_ful
          WHERE origin_id = $1
          LIMIT 1`,
        [matchedStateless.id]
      );

      if (!st.rows[0]) {
        // fallback theo method+path (phòng khi origin_id chưa sync)
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
        // Bật stateful nhưng chưa provision xong
        return res.status(500).json({
          message: "Stateful endpoint is enabled but not provisioned",
          detail: { method, path: matchedPath, origin_id: matchedStateless.id },
        });
      }

      if (st.rows[0].is_active === false) {
        // Endpoint stateful đang tắt
        return res.status(404).json({
          message: "Stateful endpoint is disabled",
          detail: { method, path: matchedPath },
        });
      }

      // Tạo meta cho handler
      // subPath: phần sau /:workspace/:project, VD "/cat/1"
      const segments = req.path.split("/").filter(Boolean);
      const subPath = "/" + segments.slice(2).join("/");
      const meta = {
        method,
        basePath,
        rawPath: normPath,
        subPath, // 👈 thêm subPath để stateless xử lý
        projectId, // 👈 lưu projectId đã resolve từ :project
        statelessId: ep.id,
        statefulId: st?.id || null,
      };
      const mode = ep.is_stateful ? "stateful" : "stateless";
      cacheSet(ck, { mode, meta });
      req.universal = meta;
      if (mode === "stateless") {
        return runHandler(statelessHandler, req, res, next);
      }
      return runHandler(statefulHandler, req, res, next);
    }

    // → Stateless mode
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
