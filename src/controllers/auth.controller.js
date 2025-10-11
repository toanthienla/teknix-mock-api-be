// src/controllers/auth.controller.js
const bcrypt = require('bcryptjs');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken
} = require('../utils/jwt');

/**
 * Đăng ký user mới
 */
exports.register = async (req, res) => {
  try {
    const db = req.db.stateless;
    const { username, password } = req.body;

    // Kiểm tra có username/password không
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    // ✅ Kiểm tra độ dài password tối thiểu 8 ký tự
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });

    // Kiểm tra username đã tồn tại chưa
    const existingUser = await db.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    if (existingUser.rows.length > 0)
      return res.status(400).json({ error: 'Username already exists' });

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Lưu vào DB
    const result = await db.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hashedPassword]
    );

    const user = result.rows[0];

    // Tạo token
    const accessToken = generateAccessToken({ user_id: user.id, username: user.username });
    const refreshToken = generateRefreshToken({ user_id: user.id });

    // Gửi cookie (dev: sameSite=lax, không secure)
    res.cookie('access_token', accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 60 * 1000, // 15 phút
    });

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 ngày
    });

    // Trả kết quả
    res.status(201).json({
      message: 'Registration successful',
      user: { id: user.id, username: user.username },
    });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};


/**
 * Đăng nhập
 */
exports.login = async (req, res) => {
  try {
    const db = req.db.stateless;
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const userQuery = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = userQuery.rows[0];

    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    // Tạo token
    const accessToken = generateAccessToken({ user_id: user.id, username: user.username });
    const refreshToken = generateRefreshToken({ user_id: user.id });

    // Set cookie
    res.cookie('access_token', accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      message: 'Login successful',
      user: { id: user.id, username: user.username },
      token: accessToken, // thêm để test Postman
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Refresh access token
 */
exports.refreshToken = async (req, res) => {
  try {
    const refreshToken = req.cookies.refresh_token;
    if (!refreshToken)
      return res.status(401).json({ error: 'No refresh token' });

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded)
      return res.status(401).json({ error: 'Invalid refresh token' });

    // Tạo token mới
    const newAccessToken = generateAccessToken({ user_id: decoded.user_id });
    const newRefreshToken = generateRefreshToken({ user_id: decoded.user_id });

    res.cookie('access_token', newAccessToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refresh_token', newRefreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ message: 'Token refreshed', newAccessToken });

  } catch (err) {
    console.error('Refresh token error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Đăng xuất
 */
exports.logout = (req, res) => {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
  };

  res.clearCookie('access_token', cookieOptions);
  res.clearCookie('refresh_token', cookieOptions);

  return res.json({ message: 'Logged out' });
};
