// src/routes/statefulEndpoint.routes.js
const express = require("express");
const router = express.Router();
const controller = require("../controllers/statefulEndpoint.controller");

// Convert endpoint sang stateful
// POST /StatefullEndpointResponse/:id/convert-stateful
router.post("/:id/convert-stateful", controller.convertToStateful);

// Update response body + delay
// PATCH /StatefullEndpointResponse/:id
router.put("/StatefullEndpointResponse/:id", controller.updateEndpointResponse);

module.exports = router;
