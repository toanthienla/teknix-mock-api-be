// src/utils/jwt.js
const jwt = require('jsonwebtoken');
require('dotenv').config();

// 🧾 Tạo access token (ngắn hạn)
function generateAccessToken(payload) {
  return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXP || '15m',
  });
}

// 🔁 Tạo refresh token (dài hạn)
function generateRefreshToken(payload) {
  return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXP || '7d',
  });
}

// ✅ Xác thực access token
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
  } catch (err) {
    return null;
  }
}

// ✅ Xác thực refresh token
function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
  } catch (err) {
    return null;
  }
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
