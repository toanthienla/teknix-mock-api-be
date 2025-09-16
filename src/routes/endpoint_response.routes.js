const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/endpoint_response.controller');
const asyncHandler = require('../middlewares/asyncHandler');

// ENDPOINT RESPONSES
// Lấy tất cả response của endpoint mock theo query: ?endpoint_id=2
router.get('/endpoint_responses', asyncHandler(ctrl.listByEndpointQuery));

// Cập nhật priority theo danh sách (đặt trước route :id)
router.put('/endpoint_responses/priority', asyncHandler(ctrl.updatePriorities));

// Đặt một response làm mặc định (đặt trước route :id)
router.put('/endpoint_responses/:id/set_default', asyncHandler(ctrl.setDefault));

// Lấy một response cụ thể theo id (đảm bảo đặt sau route tĩnh); validate số trong controller
router.get('/endpoint_responses/:id', asyncHandler(ctrl.getById));

// Tạo response mới cho endpoint mock
router.post('/endpoint_responses', asyncHandler(ctrl.create));

// Chỉnh sửa response (validate số trong controller)
router.put('/endpoint_responses/:id', asyncHandler(ctrl.update));

// Xóa response (validate số trong controller)
router.delete('/endpoint_responses/:id', asyncHandler(ctrl.remove));

module.exports = router;
