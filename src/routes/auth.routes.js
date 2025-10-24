// src/routes/auth.routes.js
const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const asyncHandler = require("../middlewares/asyncHandler");
const auth = require("../middlewares/authMiddleware");

// POST /auth/register
router.post("/register", authController.register);

// POST /auth/login
router.post("/login", authController.login);

// POST /auth/refresh
router.post("/refresh", authController.refreshToken);

// POST /auth/logout
router.post("/logout", authController.logout);

// ✅ Lấy thông tin user hiện tại từ token (cookie hoặc header)
router.get("/me", auth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ id: req.user.id, username: req.user.username });
});

module.exports = router;
