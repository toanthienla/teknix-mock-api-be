// src/routes/project_request_log.routes.js
const express = require("express");
const controller = require("../controllers/project_request_log.controller");

const router = express.Router();

router.get("/", controller.listLogs);
router.get("/:id", controller.getLogsByProjectId);

module.exports = router;
