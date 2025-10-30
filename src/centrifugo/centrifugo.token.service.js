require("dotenv").config();
const HMAC_SECRET = process.env.CENTRIFUGO_HMAC_SECRET;
if (!HMAC_SECRET) throw new Error("Missing env CENTRIFUGO_HMAC_SECRET");

async function getSignJWT() {
  const { SignJWT } = await import("jose");
  return SignJWT;
}

/**
 * Ký HS256
 * @param {object} payload
 * @param {string|number} expStr ví dụ '10m', '1h'
 */
async function signHS256(payload, expStr = "10m") {
  const SignJWT = await getSignJWT();
  const secret = new TextEncoder().encode(HMAC_SECRET);

  const jwt = await new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expStr).sign(secret);

  return jwt;
}

/**
 * Tạo connection token
 * @param {string} userId (string)
 */
async function createConnectionToken(userId, exp = "10m") {
  if (!userId) throw new Error("userId required");
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
