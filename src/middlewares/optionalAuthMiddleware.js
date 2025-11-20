// middlewares/optionalAuthMiddleware.js
const { verifyAccessToken } = require("../utils/jwt");

/**
 * Middleware lấy user từ JWT token nếu có, nhưng KHÔNG require auth
 * - Cố gắng lấy token từ cookie hoặc header Authorization
 * - Nếu token hợp lệ → set req.user
 * - Nếu token không hợp lệ hoặc không có → tiếp tục, req.user = undefined
 * 
 * Các handler sau sẽ dùng req.user để quyết định cần auth hay không
 */
function optionalAuthMiddleware(req, res, next) {
  try {
    // 1) Lấy token từ cookie hoặc header Authorization
    let token = req.cookies?.access_token;
    if (!token) {
      const authz = req.headers["authorization"] || req.headers["Authorization"];
      if (typeof authz === "string") {
        // chấp nhận "Bearer <token>" hoặc token trần
        const parts = authz.trim().split(/\s+/);
        token = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : authz;
      }
    }

    // Nếu không có token, tiếp tục không set req.user
    if (!token) {
      console.log(`[optionalAuth] No token found, allowing anonymous access`);
      return next();
    }

    // 2) Xác thực token
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      console.log(`[optionalAuth] Invalid token, allowing as anonymous`);
      return next();
    }

    // 3) Chuẩn hoá user
    const rawUid = decoded.user_id ?? decoded.id ?? decoded.sub ?? decoded.userId ?? null;
    const uidNum = Number(rawUid);
    if (!Number.isFinite(uidNum)) {
      console.log(`[optionalAuth] Invalid user id in token, allowing as anonymous`);
      return next();
    }

    const user = {
      id: uidNum,
      user_id: uidNum,
      username: decoded.username ?? decoded.name ?? null,
      roles: decoded.roles ?? decoded.role ?? null,
      _tokenPayload: decoded,
    };

    // 4) Gắn vào req & res.locals
    req.user = user;
    res.locals.user = user;

    console.log(`[optionalAuth] Authenticated user ${uidNum}`);
    return next();
  } catch (err) {
    console.error("[optionalAuth] error:", err?.message || err);
    // Cho phép tiếp tục ngay cả khi có lỗi
    return next();
  }
}

module.exports = optionalAuthMiddleware;
