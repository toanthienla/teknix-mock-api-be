// middlewares/authMiddleware.js
const { verifyAccessToken } = require('../utils/jwt');

/**
 * Middleware kiểm tra JWT access token trong cookie hoặc header
 */
function authMiddleware(req, res, next) {
  try {
    // 1️⃣ Lấy token từ cookie hoặc header Authorization
    const token =
      req.cookies?.access_token ||
      req.headers['authorization']?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Missing access token' });
    }

    // 2️⃣ Xác thực token
    const decoded = verifyAccessToken(token);

    if (!decoded) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }

    // 3️⃣ Gắn thông tin user vào request để các route khác có thể dùng
    req.user = decoded;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = authMiddleware;
