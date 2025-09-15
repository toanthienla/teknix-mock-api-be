const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/project.controller');
const asyncHandler = require('../middlewares/asyncHandler');

// Get all projects by workspace
router.get('/workspaces/:workspaceId/projects', asyncHandler(ctrl.listProjects));

// Get project by id
router.get('/workspaces/:workspaceId/projects/:id', asyncHandler(ctrl.getProjectById));

// Create project
router.post('/workspaces/:workspaceId/projects', asyncHandler(ctrl.createProject));

// Update project
router.put('/workspaces/:workspaceId/projects/:id', asyncHandler(ctrl.updateProject));

// Delete project
router.delete('/workspaces/:workspaceId/projects/:id', asyncHandler(ctrl.deleteProject));

module.exports = router;
