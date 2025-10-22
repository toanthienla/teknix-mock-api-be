const express = require("express");
const router = express.Router();
const { createConnectionToken, createSubscriptionToken } = require("../centrifugo/centrifugo.token.service");

// Giả định bạn có middleware auth lấy user từ session/jwt app của bạn.
// Ở đây demo đơn giản nhận userId qua query/body (dev only).
// Production: lấy userId từ auth thực tế của bạn.

router.get("/centrifugo/conn-token", async (req, res) => {
  try {
    const userId = req.query.user_id || "user_123"; // thay bằng req.user.id trong thực tế
    const token = await createConnectionToken(userId, "15m");
    res.json({ token, user_id: userId, exp: "15m" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/centrifugo/sub-token", async (req, res) => {
  try {
    const userId = req.query.user_id || "user_123";
    const channel = req.query.channel;
    if (!channel) return res.status(400).json({ error: "channel required" });
    const token = await createSubscriptionToken(userId, channel, "15m");
    res.json({ token, user_id: userId, channel, exp: "15m" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
