// src/routes/folder.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/folder.controller');
const asyncHandler = require('../middlewares/asyncHandler');

// Get all folders (filter by project_id nếu có query param)
// GET /folder?project_id=123
router.get('/', asyncHandler(ctrl.listFolders));

// Get folder by id
// GET /folder/:id
router.get('/:id', asyncHandler(ctrl.getFolderById));

// Create folder
// POST /folder
router.post('/', asyncHandler(ctrl.createFolder));

// Update folder
// PUT /folder/:id
router.put('/:id', asyncHandler(ctrl.updateFolder));

// Delete folder
// DELETE /folder/:id
router.delete('/:id', asyncHandler(ctrl.deleteFolder));

module.exports = router;
