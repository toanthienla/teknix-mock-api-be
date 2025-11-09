require("dotenv").config();
const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const auth = require("../middlewares/authMiddleware");
const { createConnectionTokenWithSubs, createSubscriptionToken, createConnectionToken } = require("../centrifugo/centrifugo.token.service");

const CONN_TOKEN_TTL = process.env.CENTRIFUGO_CONN_TOKEN_TTL || "7d";
const SUB_TOKEN_TTL = process.env.CENTRIFUGO_SUB_TOKEN_TTL || "7d";

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

// Chỉ cấp token ở mức ENDPOINT nếu endpoint bật websocket_config.enabled = true
// và project bật websocket_enabled = true.
router.post("/centrifugo/endpoint-connect-token", auth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { endpoint_id, exp } = req.body || {};
    const endpointId = Number(endpoint_id);
    if (!Number.isInteger(endpointId)) {
      return res.status(400).json({ error: "endpoint_id must be an integer" });
    }
    // Lấy thông tin endpoint + project + websocket config
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
    if (!rows.length) {
      return res.status(404).json({ error: "endpoint_not_found" });
    }
    const row = rows[0];

    // Kiểm tra điều kiện bật thông báo
    if (row.websocket_enabled !== true) {
      return res.status(403).json({ error: "project_ws_disabled" });
    }
    if (row.endpoint_active !== true) {
      return res.status(403).json({ error: "endpoint_inactive" });
    }
    const cfg = row.websocket_config || {};
    if (!cfg.enabled) {
      return res.status(403).json({ error: "endpoint_notifications_disabled" });
    }

    // Kênh endpoint-only
    const channel = `pj:${row.project_id}:ep:${row.endpoint_id}`;
    const token = await createConnectionTokenWithSubs(String(userId), [channel], exp || CONN_TOKEN_TTL);
    // Timestamps for client-side timing
    const issuedAtMs = Date.now();
    const ttlMs = parseTtlToMs(exp || CONN_TOKEN_TTL);
    const expiresAtMs = ttlMs > 0 ? issuedAtMs + ttlMs : null;

    return res.json({
      token,
      user_id: userId,
      channels: [channel],
      mode: "connection_with_subs",
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

module.exports = router;
