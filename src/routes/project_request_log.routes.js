// src/routes/project_request_log.routes.js
const express = require("express");
const controller = require("../controllers/project_request_log.controller");
const router = express.Router();

// ✅ Đặt route có query param project_id phía trên
router.get("/by_project", controller.getLogsByProjectId);

// ✅ Danh sách tổng quát (có thể có nhiều filter)
router.get("/", controller.listLogs);

// ✅ Lấy 1 log cụ thể
router.get("/:id", controller.getLogById);

module.exports = router;
