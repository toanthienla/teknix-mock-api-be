// src/routes/folder.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/folder.controller');
const asyncHandler = require('../middlewares/asyncHandler');
const validateFolder = require('../middlewares/validateFolder'); // Import middleware mới
const auth = require('../middlewares/authMiddleware');

// Get all folders (filter by project_id nếu có query param)
// GET /folders?project_id=123 HOẶC GET /folders
router.get('/', asyncHandler(ctrl.listFolders));

// Get folder by id
// GET /folder/:id
router.get('/:id', asyncHandler(ctrl.getFolderById));

// Create folder
// POST /folder
router.post('/', auth, validateFolder, asyncHandler(ctrl.createFolder));

// Update folder
// PUT /folder/:id
router.put('/:id', auth, validateFolder, asyncHandler(ctrl.updateFolder)); // Gắn middleware

// Delete folder
// DELETE /folder/:id
router.delete('/:id', auth, asyncHandler(ctrl.deleteFolder));

// // ✅ Route mới để lấy thông tin chủ folder
// router.get("/getOwner/:id", ctrl.getFolderOwner);

// ✅ Check owner of folder
// router.get("/checkOwner/:id", auth, asyncHandler(ctrl.checkFolderOwner));

module.exports = router;