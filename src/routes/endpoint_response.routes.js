const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/endpoint_response.controller');
const asyncHandler = require('../middlewares/asyncHandler');

// ENDPOINT RESPONSES
// Lấy tất cả response của endpoint mock theo query: ?endpoint_id=2
router.get('/endpoint_responses', asyncHandler(ctrl.listByEndpointQuery));

// Lấy một response cụ thể theo id
router.get('/endpoint_responses/:id', asyncHandler(ctrl.getById));

// Tạo response mới cho endpoint mock
router.post('/endpoint_responses', asyncHandler(ctrl.create));

// Chỉnh sửa response
router.put('/endpoint_responses/:id', asyncHandler(ctrl.update));

// Xóa response
router.delete('/endpoint_responses/:id', asyncHandler(ctrl.remove));

module.exports = router;
