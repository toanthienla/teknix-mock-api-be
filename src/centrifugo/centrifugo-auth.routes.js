const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();

const HMAC_SECRET = process.env.CENTRIFUGO_HMAC_SECRET || "MY_SUPER_SECRET_456";

router.get("/centrifugo/token", (req, res) => {
  const userId = "user_123"; // demo

  // THÊM claim channels: cho phép subscribe kênh 'news'
  const payload = {
    sub: userId,
    channels: ["news"], // <- quan trọng
  };

  const token = jwt.sign(payload, HMAC_SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });

  res.json({ token, userId });
});

module.exports = router;
