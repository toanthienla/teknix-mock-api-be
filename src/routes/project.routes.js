const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/project.controller");
const asyncHandler = require("../middlewares/asyncHandler");
const validateProject = require("../middlewares/validateProject");

// Get all projects (filter by workspace_id nếu có query param)
// GET /projects
router.get("/", asyncHandler(ctrl.listProjects));

// Get project by id (nếu vẫn cần, mặc dù contract không yêu cầu)
// GET /projects/:id
router.get("/:id", asyncHandler(ctrl.getProjectById));

// Create project (body chứa workspace_id + name, validate trước)
// POST /projects
router.post("/", validateProject, asyncHandler(ctrl.createProject));

// Update project
// PUT /projects/:id   (hỗ trợ: name/description hoặc chỉ websocket_enabled)
router.put("/:id", asyncHandler(ctrl.updateProject));

// Delete project
// DELETE /projects/:id
router.delete("/:id", asyncHandler(ctrl.deleteProject));

module.exports = router;
