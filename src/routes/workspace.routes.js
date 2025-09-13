// src/routes/workspace.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/workspace.controller');
const auth = require('../middlewares/auth');
const asyncHandler = require('../middlewares/asyncHandler');

router.use(auth); // tất cả route workspace cần login

router.get('/', asyncHandler(ctrl.listWorkspaces));
router.post('/', asyncHandler(ctrl.createWorkspace));
router.put('/:id', asyncHandler(ctrl.updateWorkspace));
router.delete('/:id', asyncHandler(ctrl.deleteWorkspace));

module.exports = router;
