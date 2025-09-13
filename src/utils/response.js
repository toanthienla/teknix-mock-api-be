// src/utils/response.js
// Hàm chuẩn hóa response trả về cho client (Postman dễ đọc)

function success(res, data = null, message = '') {
  return res.json({ success: true, message, data });
}

function error(res, status = 400, message = 'Bad Request', details = null) {
  return res.status(status).json({
    success: false,
    error: { message, details }
  });
}

module.exports = { success, error };
