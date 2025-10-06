// src/routes/universalHandler.js
const express = require("express");
const router = express.Router();

const statefulHandler = require("./statefulHandler");
const statelessHandler = require("./mock.routes");


/* ========== Helpers ========== */
function normalizePath(raw) {
  if (!raw) return "/";
  let p = raw.split("?")[0];
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p.startsWith("/")) p = "/" + p;
  return p || "/";
}

// Trả { base, id } nếu segment cuối là số; ngược lại id = null
function splitBaseAndNumericId(path) {
  const segs = (path || "").split("/").filter(Boolean);
  if (segs.length === 0) return { base: "/", id: null };
  const last = segs[segs.length - 1];
  if (/^\d+$/.test(last)) {
    segs.pop();
    const base = "/" + segs.join("/");
    return { base: base || "/", id: Number(last) };
  }
  return { base: path, id: null };
}

// Hỗ trợ cả router (có .handle) và middleware function
function runHandler(handler, req, res, next) {
  if (handler && typeof handler.handle === "function") return handler.handle(req, res, next);
  if (typeof handler === "function") return handler(req, res, next);
  throw new Error("Invalid handler export");
}

/* ========== Main ========== */
router.use(async (req, res, next) => {
  try {
    const method = (req.method || "GET").toUpperCase();
    const normPath = normalizePath(req.path || req.originalUrl || "/");
    const { base: baseCandidate, id: idCandidate } = splitBaseAndNumericId(normPath);

    // Danh sách ứng viên path theo thứ tự ưu tiên: exact → base (nếu có id)
    const exact = normPath;
    const candidates = Array.from(
      new Set((idCandidate !== null && baseCandidate !== normPath) ? [exact, baseCandidate] : [exact])
    ); // luôn >=1 phần tử, không có null

    // 1) Truy vấn "registry" stateless để xác định endpoint + chế độ
    const statelessQ = await req.db.stateless.query(
      `
      SELECT id, path, method, is_stateful, is_active
      FROM endpoints
      WHERE UPPER(method) = $1
        AND path = ANY($2)
      ORDER BY COALESCE(array_position($2, path), 999)
      LIMIT 1
      `,
      [method, candidates] // $2 là text[]
    );
    const ep = (statelessQ.rows && statelessQ.rows[0]) ? statelessQ.rows[0] : null;

    if (!ep) {
      return res.status(404).json({ message: "Endpoint not found", detail: { method, path: normPath } });
    }

    const matchedPath = normalizePath(ep.path || "");
    const idInUrl = matchedPath !== normPath ? idCandidate : null;

    // Bảo toàn tương thích ngược cho các handler cũ:
    // - req.endpoint: dùng path/method đã match (stateless registry)
    // - req.params.id: chỉ set nếu chưa tồn tại
    req.endpoint = { id: ep.id, method, path: matchedPath };
    if (idInUrl !== null) {
      req.params = req.params || {};
      if (typeof req.params.id === "undefined") {
        req.params.id = idInUrl;
      }
    }

    // 2) Quyết định stateful/stateless dựa vào cờ
    if (ep.is_stateful === true) {
      // Xác minh tồn tại & is_active ở DB stateful (ưu tiên origin_id)
      let st = await req.db.stateful.query(
        `SELECT id, is_active
           FROM endpoints_ful
          WHERE origin_id = $1
          LIMIT 1`,
        [ep.id]
      );

      if (!st.rows || !st.rows[0]) {
        // Fallback theo method+path (phòng khi origin_id chưa sync)
        st = await req.db.stateful.query(
          `SELECT id, is_active
             FROM endpoints_ful
            WHERE UPPER(method) = $1 AND path = $2
            LIMIT 1`,
          [method, matchedPath]
        );
      }

      const stRow = st.rows && st.rows[0] ? st.rows[0] : null;
      if (!stRow) {
        return res.status(500).json({
          message: "Stateful endpoint is enabled but not provisioned",
          detail: { method, path: matchedPath, origin_id: ep.id }
        });
      }
      if (stRow.is_active === false) {
        return res.status(404).json({
          message: "Stateful endpoint is disabled",
          detail: { method, path: matchedPath }
        });
      }

      // Meta mới (nếu handler mới dùng)
      req.universal = {
        mode: "stateful",
        method,
        rawPath: normPath,
        basePath: matchedPath,
        idInUrl,
        statelessId: ep.id,
        statefulId: stRow.id
      };
      // Tương thích ngược: cung cấp id stateful nếu handler cũ cần
      req.endpoint_stateful = { id: stRow.id };

      return runHandler(statefulHandler, req, res, next);
    }

    // → Stateless mode
    if (ep.is_active === false) {
      return res.status(404).json({
        message: "Stateless endpoint is disabled",
        detail: { method, path: matchedPath }
      });
    }

    // Meta mới (nếu handler mới dùng)
    req.universal = {
      mode: "stateless",
      method,
      rawPath: normPath,
      basePath: matchedPath,
      idInUrl,
      statelessId: ep.id
    };

    return runHandler(statelessHandler, req, res, next);

  } catch (err) {
    console.error("❌ universalHandler error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

module.exports = router;
