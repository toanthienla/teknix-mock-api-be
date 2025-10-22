// src/routes/project_request_log.routes.js
const express = require("express");
const controller = require("../controllers/project_request_log.controller");

const router = express.Router();

router.get("/", controller.listLogs);
// Lấy theo project_id (ĐẶT TRƯỚC để không bị nuốt bởi "/:id")
router.get("/project/:id", controller.getLogsByProjectId);
// ✅ Lấy 1 log theo log_id
router.get("/:id", controller.getLogById);
module.exports = router;
