require("dotenv").config();
const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const auth = require("../middlewares/authMiddleware");
const {
  createConnectionTokenWithSubs,
  createConnectionToken,
  createSubscriptionToken, // (chưa dùng, để sẵn)
} = require("../centrifugo/centrifugo.token.service");

// TTL chuỗi kiểu '7d'
const CONN_TOKEN_TTL = process.env.CENTRIFUGO_CONN_TOKEN_TTL || "7d";
const WS_URL = (process.env.CENTRIFUGO_WS || "").trim();
// TTL tối thiểu của cookie hiển thị token cho FE (vd '10m')
const COOKIE_MIN_TTL = process.env.CENTRIFUGO_WS_COOKIE_MIN_TTL || "10m";
// giống auth.controller.js
const isProduction = process.env.NODE_ENV === "production";
const cookieSameSite = isProduction ? "none" : "lax";
const cookieSecure = isProduction;

// helper: set các cookie để FE hiển thị / copy
function setWsTokenCookies(res, { token, channels, ttlMs }) {
  // minAge từ env, fallback 10 phút
  const minAgeMs = parseTtlToMs(COOKIE_MIN_TTL) || 10 * 60 * 1000;

  const optsReadable = {
    httpOnly: false, // cho FE đọc được -> Application > Cookies
    secure: cookieSecure,
    sameSite: cookieSameSite,
    path: "/",
    maxAge: Math.max(minAgeMs, ttlMs || 0),
  };
  // token thô
  res.cookie("centrifugo_ws_token", token, optsReadable);
  // danh sách kênh (để FE show kèm)
  if (channels?.length) {
    res.cookie("centrifugo_ws_channels", JSON.stringify(channels), optsReadable);
  }
  // frame connect đã build sẵn để người dùng copy
  res.cookie("centrifugo_ws_connect", JSON.stringify({ id: 1, connect: { token } }), optsReadable);
}

// Parse TTL strings like "10m", "7d", "30s", "2h" → milliseconds
function parseTtlToMs(ttl) {
  const s = String(ttl || "").trim();
  const m = s.match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "s").toLowerCase(); // default seconds
  const mul = unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
  return n * mul;
}

/**
 * CẤP TOKEN THEO ENDPOINT (giữ nguyên route cũ)
 * - Chỉ cấp khi: project.websocket_enabled = true
 * - endpoint.is_active = true
 * - endpoint.websocket_config.enabled = true
 * - Subs sẵn kênh: pj:{projectId}-ep-{endpointId}
 */
router.post("/centrifugo/endpoint-connect-token", auth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { endpoint_id, exp, include_subs } = req.body || {};
    const endpointId = Number(endpoint_id);
    if (!Number.isInteger(endpointId)) {
      return res.status(400).json({ error: "endpoint_id must be an integer" });
    }

    // Lấy endpoint + project + websocket_config
    const sql = `
      SELECT e.id AS endpoint_id,
             e.is_active AS endpoint_active,
             e.websocket_config,
             p.id AS project_id,
             p.websocket_enabled
        FROM endpoints e
        JOIN folders f ON f.id = e.folder_id
        JOIN projects p ON p.id = f.project_id
       WHERE e.id = $1
       LIMIT 1
    `;
    const { rows } = await pool.query(sql, [endpointId]);
    if (!rows.length) return res.status(404).json({ error: "endpoint_not_found" });
    const row = rows[0];

    if (row.websocket_enabled !== true) return res.status(403).json({ error: "project_ws_disabled" });
    if (row.endpoint_active !== true) return res.status(403).json({ error: "endpoint_inactive" });

    const cfg = row.websocket_config || {};
    if (!cfg.enabled) return res.status(403).json({ error: "endpoint_notifications_disabled" });

    const channel = `pj:${row.project_id}-ep-${row.endpoint_id}`;
    const wantSubs = include_subs !== false; // mặc định: true
    const token = wantSubs ? await createConnectionTokenWithSubs(String(userId), [channel], exp || CONN_TOKEN_TTL) : await createConnectionToken(String(userId), exp || CONN_TOKEN_TTL);

    const issuedAtMs = Date.now();
    const ttlMs = parseTtlToMs(exp || CONN_TOKEN_TTL);
    const expiresAtMs = ttlMs > 0 ? issuedAtMs + ttlMs : null;
    // ⬇️ ghi cookie để FE đọc & hiển thị sẵn frame connect
    setWsTokenCookies(res, { token, channels: [channel], ttlMs });

    return res.json({
      token,
      user_id: userId,
      channels: [channel],
      mode: wantSubs ? "connection_with_subs" : "connection_only",
      exp: exp || CONN_TOKEN_TTL,
      issued_at: new Date(issuedAtMs).toISOString(),
      issued_at_epoch_ms: issuedAtMs,
      expires_in_ms: ttlMs,
      expires_at_epoch_ms: expiresAtMs,
    });
  } catch (e) {
    console.error("endpoint-connect-token error:", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * CẤP TOKEN THEO PROJECT (route mới bạn cần)
 * - Kiểm tra project.websocket_enabled = true
 * - Subs sẵn kênh: pj:{projectId} (gom mọi endpoint đã bật trong project)
 */
router.post("/centrifugo/project-connect-token", auth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { project_id, exp, include_subs } = req.body || {};
    const projectId = Number(project_id);
    if (!Number.isInteger(projectId)) {
      return res.status(400).json({ error: "project_id must be an integer" });
    }

    // Kiểm tra project tồn tại & bật công tắc tổng
    const { rows } = await pool.query(`SELECT id, websocket_enabled FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    if (!rows.length) return res.status(404).json({ error: "project_not_found" });
    if (rows[0].websocket_enabled !== true) return res.status(403).json({ error: "project_ws_disabled" });

    const channel = `pj:${projectId}`;
    const wantSubs = include_subs !== false; // mặc định: true
    const token = wantSubs ? await createConnectionTokenWithSubs(String(userId), [channel], exp || CONN_TOKEN_TTL) : await createConnectionToken(String(userId), exp || CONN_TOKEN_TTL);

    const issuedAtMs = Date.now();
    const ttlMs = parseTtlToMs(exp || CONN_TOKEN_TTL);
    const expiresAtMs = ttlMs > 0 ? issuedAtMs + ttlMs : null;

    return res.json({
      token,
      user_id: userId,
      ws_url: WS_URL,
      channels: [channel],
      mode: wantSubs ? "connection_with_subs" : "connection_only",
      exp: exp || CONN_TOKEN_TTL,
      issued_at: new Date(issuedAtMs).toISOString(),
      issued_at_epoch_ms: issuedAtMs,
      expires_in_ms: ttlMs,
      expires_at_epoch_ms: expiresAtMs,
    });
  } catch (e) {
    console.error("project-connect-token error:", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
