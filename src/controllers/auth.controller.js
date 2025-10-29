const bcrypt = require("bcryptjs");
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require("../utils/jwt");

/**
 * Helper cookie options based on environment
 */
const isProduction = process.env.NODE_ENV === "production";
const cookieSameSite = isProduction ? "none" : "lax";
const cookieSecure = isProduction; // when SameSite is 'none' browsers require Secure

/**
 * Đăng ký user mới
 */
exports.register = async (req, res) => {
  try {
    const db = req.db.stateless;
    const { username, password } = req.body;

    // Kiểm tra có username/password không
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    // ✅ Kiểm tra độ dài password tối thiểu 8 ký tự
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters long" });

    // Kiểm tra username đã tồn tại chưa
    const existingUser = await db.query("SELECT * FROM users WHERE username = $1", [username]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: "Username already exists" });

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Lưu vào DB
    const result = await db.query("INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username", [username, hashedPassword]);

    const user = result.rows[0];

    // Tạo token
    const accessToken = generateAccessToken({ user_id: user.id, username: user.username });
    const refreshToken = generateRefreshToken({ user_id: user.id });

    // Shared cookie options
    const accessCookieOptions = {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: "/",
      maxAge: 15 * 60 * 1000, // 15 phút
    };

    const refreshCookieOptions = {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 ngày
    };

    // Gửi cookie
    res.cookie("access_token", accessToken, accessCookieOptions);
    res.cookie("refresh_token", refreshToken, refreshCookieOptions);

    // Trả kết quả
    res.status(201).json({
      message: "Registration successful",
      user: { id: user.id, username: user.username },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Đăng nhập
 */
exports.login = async (req, res) => {
  try {
    const db = req.db.stateless;
    const { username, password } = req.body;

    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    const userQuery = await db.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = userQuery.rows[0];

    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    // Tạo token
    const accessToken = generateAccessToken({ user_id: user.id, username: user.username });
    const refreshToken = generateRefreshToken({ user_id: user.id });

    // Shared cookie options
    const accessCookieOptions = {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: "/",
      maxAge: 15 * 60 * 1000,
    };

    const refreshCookieOptions = {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };

    // Set cookie
    res.cookie("access_token", accessToken, accessCookieOptions);
    res.cookie("refresh_token", refreshToken, refreshCookieOptions);

    res.json({
      message: "Login successful",
      user: { id: user.id, username: user.username },
      token: accessToken, // thêm để test Postman
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Refresh access token
 */
exports.refreshToken = async (req, res) => {
  try {
    const refreshToken = req.cookies.refresh_token;
    if (!refreshToken) return res.status(401).json({ error: "No refresh token" });

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) return res.status(401).json({ error: "Invalid refresh token" });

    // Tạo token mới
    const newAccessToken = generateAccessToken({ user_id: decoded.user_id });
    const newRefreshToken = generateRefreshToken({ user_id: decoded.user_id });

    const accessCookieOptions = {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: "/",
      maxAge: 15 * 60 * 1000,
    };

    const refreshCookieOptions = {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };

    res.cookie("access_token", newAccessToken, accessCookieOptions);
    res.cookie("refresh_token", newRefreshToken, refreshCookieOptions);

    res.json({ message: "Token refreshed", newAccessToken });
  } catch (err) {
    console.error("Refresh token error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Đăng xuất
 */
exports.logout = (req, res) => {
  const cookieOptions = {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    path: "/",
  };

  res.clearCookie("access_token", cookieOptions);
  res.clearCookie("refresh_token", cookieOptions);

  return res.json({ message: "Logged out" });
};

// Lấy thông tin người dùng hiện tại
exports.getCurrentUser = async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // ✅ Lấy kết nối DB stateless từ request
    const client = req.db?.stateless;
    if (!client) {
      console.error("❌ Database client (stateless) not found on request");
      return res.status(500).json({ message: "Database connection error" });
    }

    const query = "SELECT username FROM users WHERE id = $1";
    const result = await client.query(query, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({ user_id: userId, username: result.rows[0].username });
  } catch (error) {
    console.error("Error in getCurrentUser:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};