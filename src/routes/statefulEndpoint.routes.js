// src/routes/statefulEndpoint.routes.js
const express = require("express");
const router = express.Router();
const controller = require("../controllers/statefulEndpoint.controller");

// Endpoint: POST /endpoints/:id/convert-stateful
router.post("/:id/convert-stateful", controller.convertToStateful);

module.exports = router;
