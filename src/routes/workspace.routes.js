const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/workspace.controller");
const asyncHandler = require("../middlewares/asyncHandler");
const validateWorkspace = require("../middlewares/validateWorkspace");

// Get all workspaces
// GET /workspaces
router.get("/", asyncHandler(ctrl.listWorkspaces));

// Get workspace by id
// GET /workspaces/:id
router.get("/:id", asyncHandler(ctrl.getWorkspace));

// Create workspace (validate name)
// POST /workspaces
router.post("/", validateWorkspace, asyncHandler(ctrl.createWorkspace));

// Update workspace (validate name)
// PUT /workspaces/:id
router.put("/:id", validateWorkspace, asyncHandler(ctrl.updateWorkspace));

// Delete workspace
// DELETE /workspaces/:id
router.delete("/:id", asyncHandler(ctrl.deleteWorkspace));

module.exports = router;
