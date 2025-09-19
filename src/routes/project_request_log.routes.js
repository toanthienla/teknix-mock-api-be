const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/project_request_log.controller');
const asyncHandler = require('../middlewares/asyncHandler');

// Routes cho Project Request Logs
// Mục đích: cung cấp API xem log theo project và chi tiết 1 log
router.get('/project_request_logs', asyncHandler(ctrl.list));
router.get('/project_request_logs/:id', asyncHandler(ctrl.getById));

module.exports = router;
