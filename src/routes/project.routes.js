// src/routes/project.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/project.controller');
const auth = require('../middlewares/auth');
const asyncHandler = require('../middlewares/asyncHandler');

router.use(auth);

// Lấy danh sách project trong workspace
router.get('/workspace/:workspaceId', asyncHandler(ctrl.listProjects));

// Tạo project mới trong workspace
router.post('/workspace/:workspaceId', asyncHandler(ctrl.createProject));

// Cập nhật project theo id
router.put('/:id', asyncHandler(ctrl.updateProject));

// Xóa project theo id
router.delete('/:id', asyncHandler(ctrl.deleteProject));

module.exports = router;
