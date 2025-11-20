// middlewares/conditionalAuthMiddleware.js
const { verifyAccessToken } = require("../utils/jwt");

/**
 * Middleware auth có điều kiện:
 * - GET requests: Bypass auth (để statefulHandler/statelessHandler xử lý PUBLIC/PRIVATE)
 * - POST/PUT/DELETE: Luôn bắt auth
 * - Khác: Bắt auth
 */
async function conditionalAuthMiddleware(req, res, next) {
  try {
    const method = (req.method || "GET").toUpperCase();

    console.log(`[conditionalAuth] method=${method}, url=${req.originalUrl}`);

    // GET requests: Optional auth - try to authenticate if token present, but don't fail if missing
    if (method === "GET") {
      console.log(`[conditionalAuth] GET request - trying optional auth`);
      return tryOptionalAuth(req, res, next);
    }

    // POST/PUT/DELETE: Luôn bắt auth
    console.log(`[conditionalAuth] ${method} request - requiring auth`);
    return applyAuth(req, res, next);
  } catch (err) {
    console.error("[conditionalAuth] Unexpected error:", err?.message || err);
    return applyAuth(req, res, next);
  }
}

/**
 * Helper: Try to authenticate if token exists, but don't fail if missing
 * Used for GET requests where auth is optional
 */
function tryOptionalAuth(req, res, next) {
  try {
    // 1) Lấy token từ cookie hoặc header Authorization
    let token = req.cookies?.access_token;
    if (!token) {
      const authz = req.headers["authorization"] || req.headers["Authorization"];
      if (typeof authz === "string") {
        const parts = authz.trim().split(/\s+/);
        token = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : authz;
      }
    }

    // Nếu không có token, OK - tiếp tục với req.user = null
    if (!token) {
      console.log(`[conditionalAuth] GET - no token provided, allowing anonymous access`);
      return next();
    }

    // 2) Token exists, try to verify
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      // Token invalid, but for GET we allow it - let handler decide
      console.log(`[conditionalAuth] GET - invalid token, but allowing as public`);
      return next();
    }

    // 3) Token valid - set user
    const rawUid = decoded.user_id ?? decoded.id ?? decoded.sub ?? decoded.userId ?? null;
    const uidNum = Number(rawUid);
    if (!Number.isFinite(uidNum)) {
      // Invalid uid format, but allow continuation
      console.log(`[conditionalAuth] GET - invalid user id in token, allowing as anonymous`);
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
    console.log(`[conditionalAuth] GET - authenticated user ${uidNum}`);

    return next();
  } catch (err) {
    console.error("[conditionalAuth] tryOptionalAuth error:", err?.message || err);
    // Allow continuation even on error for GET
    return next();
  }
}

/**
 * Helper: Áp dụng auth như authMiddleware
 */
function applyAuth(req, res, next) {
  try {
    // 1) Lấy token từ cookie hoặc header Authorization
    let token = req.cookies?.access_token;
    if (!token) {
      const authz = req.headers["authorization"] || req.headers["Authorization"];
      if (typeof authz === "string") {
        const parts = authz.trim().split(/\s+/);
        token = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : authz;
      }
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized: Missing access token" });
    }

    // 2) Xác thực token
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
    }

    // 3) Chuẩn hoá user
    const rawUid = decoded.user_id ?? decoded.id ?? decoded.sub ?? decoded.userId ?? null;
    const uidNum = Number(rawUid);
    if (!Number.isFinite(uidNum)) {
      return res.status(401).json({ error: "Unauthorized: Invalid user id in token" });
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

    return next();
  } catch (err) {
    console.error("[conditionalAuth] Auth error:", err?.message || err);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

module.exports = conditionalAuthMiddleware;
