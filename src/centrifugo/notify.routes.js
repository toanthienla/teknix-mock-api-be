const express = require("express");
const router = express.Router();
const { publish } = require("../centrifugo/centrifugo.service"); // bạn đã có file service v6

router.post("/notify", async (req, res) => {
  try {
    const { channel = "news", message = "Hello from teknix_mock_api", data = {} } = req.body || {};

    const payload = { message, ...data, at: new Date().toISOString() };
    const out = await publish(channel, payload);
    return res.json({ ok: true, channel, payload, centrifugo: out });
  } catch (e) {
    const detail = e.response?.data || e.message || e.toString();
    console.error("publish error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// FE test connection: bắn 1 publication vào kênh pj:{project_id} (hoặc pj:{project_id}-ep-{endpoint_id})
router.post("/centrifugo/test-connection", async (req, res) => {
  try {
    const { project_id, endpoint_id, note } = req.body || {};
    if (!project_id) return res.status(400).json({ ok: false, error: "project_id is required" });

    const channel = endpoint_id ? `pj:${project_id}-ep-${endpoint_id}` : `pj:${project_id}`;

    const payload = {
      type: "connection_test",
      ok: true,
      project_id,
      endpoint_id: endpoint_id ?? null,
      note: note ?? "FE triggered test",
      at: new Date().toISOString(),
    };

    const out = await publish(channel, payload);
    return res.json({ ok: true, channel, payload, centrifugo: out });
  } catch (e) {
    const detail = e.response?.data || e.message || e.toString();
    console.error("test-connection publish error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

module.exports = router;
