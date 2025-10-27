const express = require("express");
const router = express.Router();
const { createConnectionToken, createSubscriptionToken } = require("../centrifugo/centrifugo.token.service");
const auth = require("../middlewares/authMiddleware");

// Giả định bạn có middleware auth lấy user từ session/jwt app của bạn.
// Ở đây demo đơn giản nhận userId qua query/body (dev only).
// Production: lấy userId từ auth thực tế của bạn.

// ✅ Đảm bảo route này chỉ được truy cập khi người dùng đã đăng nhập
router.get("/centrifugo/conn-token", auth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const token = await createConnectionToken(String(userId), "7d");
    return res.json({ token, user_id: userId, exp: "7d" });
  } catch (e) {
    console.error("conn-token error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

router.get("/centrifugo/sub-token", auth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { channel } = req.query;
    if (!channel) return res.status(400).json({ error: "channel required" });

    const token = await createSubscriptionToken(String(userId), channel, "7d");
    return res.json({ token, user_id: userId, channel, exp: "7d" });
  } catch (e) {
    console.error("sub-token error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
