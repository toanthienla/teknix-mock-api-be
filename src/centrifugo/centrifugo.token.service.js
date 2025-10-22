// src/centrifugo/centrifugo.token.service.js
const { SignJWT } = require("jose");

const HMAC_SECRET = process.env.CENTRIFUGO_HMAC_SECRET || "MY_SUPER_SECRET_456";

/**
 * Ký HS256
 * @param {object} payload
 * @param {string|number} expStr ví dụ '10m', '1h'
 */
async function signHS256(payload, expStr = "10m") {
  const secret = new TextEncoder().encode(HMAC_SECRET);
  // Chú ý: sub nên là string, ví dụ 'user_123'
  const jwt = await new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expStr).sign(secret);
  return jwt;
}

/**
 * Tạo connection token
 * @param {string} userId (string)
 */
async function createConnectionToken(userId, exp = "10m") {
  if (!userId) throw new Error("userId required");
  // sub bắt buộc
  return signHS256({ sub: String(userId) }, exp);
}

/**
 * Tạo subscription token cho 1 kênh
 * @param {string} userId
 * @param {string} channel
 */
async function createSubscriptionToken(userId, channel, exp = "10m") {
  if (!userId) throw new Error("userId required");
  if (!channel) throw new Error("channel required");
  return signHS256({ sub: String(userId), channel }, exp);
}

module.exports = {
  createConnectionToken,
  createSubscriptionToken,
};
