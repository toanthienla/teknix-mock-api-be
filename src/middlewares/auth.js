// src/middlewares/auth.js
// Middleware để kiểm tra JWT trong header Authorization

const jwt = require('jsonwebtoken');

module.exports = function (req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({
      success: false,
      error: { message: 'Thiếu token trong Authorization header' }
    });
  }

  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      success: false,
      error: { message: 'Định dạng token không hợp lệ (cần Bearer <token>)' }
    });
  }

  const token = parts[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // chứa { id, email }
    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: { message: 'Token không hợp lệ hoặc đã hết hạn' }
    });
  }
};
