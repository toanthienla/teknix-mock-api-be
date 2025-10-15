// middlewares/authMiddleware.js
const { verifyAccessToken } = require("../utils/jwt");

/**
 * Middleware kiểm tra JWT access token trong cookie hoặc header
 * - Ưu tiên cookie "access_token", fallback header "Authorization: Bearer <token>"
 * - Gắn req.user với cả 2 field: id & user_id (number), để downstream đọc thống nhất
 * - Đồng thời gắn res.locals.user để các router khác cũng truy cập được
 */
function authMiddleware(req, res, next) {
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

    if (!token) {
      return res.status(401).json({ error: "Unauthorized: Missing access token" });
    }

    // 2) Xác thực token (verifyAccessToken có thể trả null hoặc throw)
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
    }

    // 3) Chuẩn hoá user
    //    Ưu tiên decoded.user_id; nếu payload dùng sub/id thì fallback
    const rawUid = decoded.user_id ?? decoded.id ?? decoded.sub ?? decoded.userId ?? null;

    const uidNum = Number(rawUid);
    if (!Number.isFinite(uidNum)) {
      return res.status(401).json({ error: "Unauthorized: Invalid user id in token" });
    }

    const user = {
      id: uidNum, // <— cái statefulHandler đọc
      user_id: uidNum, // <— tương thích các nơi khác
      username: decoded.username ?? decoded.name ?? null,
      roles: decoded.roles ?? decoded.role ?? null,
      // giữ lại toàn bộ payload (an toàn cho logging/debug nếu cần)
      _tokenPayload: decoded,
    };

    // 4) Gắn vào req & res.locals (đừng ghi đè lần 2!)
    req.user = user;
    res.locals.user = user;

    // Debug nhẹ (tuỳ chọn)
    // console.log('🟢 Auth OK:', { id: user.id, username: user.username });

    return next();
  } catch (err) {
    console.error("Auth middleware error:", err?.message || err);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

module.exports = authMiddleware;
