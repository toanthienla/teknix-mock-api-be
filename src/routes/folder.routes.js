// src/routes/folder.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/folder.controller');
const asyncHandler = require('../middlewares/asyncHandler');
const validateFolder = require('../middlewares/validateFolder'); // Import middleware mới

// Get all folders (filter by project_id nếu có query param)
// GET /folder?project_id=123
router.get('/', asyncHandler(ctrl.listFolders));

// Get folder by id
// GET /folder/:id
router.get('/:id', asyncHandler(ctrl.getFolderById));

// Create folder
// POST /folder
router.post('/', validateFolder, asyncHandler(ctrl.createFolder)); // Gắn middleware

// Update folder
// PUT /folder/:id
router.put('/:id', validateFolder, asyncHandler(ctrl.updateFolder)); // Gắn middleware

// Delete folder
// DELETE /folder/:id
router.delete('/:id', asyncHandler(ctrl.deleteFolder));

module.exports = router;