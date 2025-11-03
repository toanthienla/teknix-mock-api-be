// const express = require("express");
// const router = express.Router();
// const { publish } = require("../centrifugo/centrifugo.service"); // bạn đã có file service v6

// router.post("/notify", async (req, res) => {
//   try {
//     const { channel = "news", message = "Hello from teknix_mock_api", data = {} } = req.body || {};

//     const payload = { message, ...data, at: new Date().toISOString() };
//     const out = await publish(channel, payload);
//     return res.json({ ok: true, channel, payload, centrifugo: out });
//   } catch (e) {
//     const detail = e.response?.data || e.message || e.toString();
//     console.error("publish error:", detail);
//     return res.status(500).json({ ok: false, error: detail });
//   }
// });

// module.exports = router;
