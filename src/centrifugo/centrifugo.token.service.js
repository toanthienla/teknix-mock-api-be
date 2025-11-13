require("dotenv").config();
const HMAC_SECRET = process.env.CENTRIFUGO_HMAC_SECRET;
if (!HMAC_SECRET) throw new Error("Missing env CENTRIFUGO_HMAC_SECRET");

// TTL mặc định cho các loại token WS (chuỗi kiểu '10m', '7d'...)
// Ưu tiên: CENTRIFUGO_DEFAULT_TOKEN_TTL → CENTRIFUGO_CONN_TOKEN_TTL → '10m'
const DEFAULT_TOKEN_TTL = process.env.CENTRIFUGO_DEFAULT_TOKEN_TTL || process.env.CENTRIFUGO_CONN_TOKEN_TTL || "10m";

async function getSignJWT() {
  const { SignJWT } = await import("jose");
  return SignJWT;
}

/**
 * Ký HS256
 * @param {object} payload
 * @param {string|number} expStr ví dụ '10m', '1h'
 */
async function signHS256(payload, expStr = DEFAULT_TOKEN_TTL) {
  const SignJWT = await getSignJWT();
  const secret = new TextEncoder().encode(HMAC_SECRET);

  const jwt = await new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expStr).sign(secret);

  return jwt;
}

/**
 * Tạo connection token
 * @param {string} userId (string)
 */
async function createConnectionToken(userId, exp = DEFAULT_TOKEN_TTL) {
  if (!userId) throw new Error("userId required");
  const iat = Math.floor(Date.now() / 1000);
  return signHS256({ sub: String(userId), iat }, exp);
}

/**
 * Tạo connection token có sẵn subs (server-side subscriptions)
 */
async function createConnectionTokenWithSubs(userId, channels = [], exp = DEFAULT_TOKEN_TTL) {
  if (!userId) throw new Error("userId required");
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error("channels array required");
  }
  const subs = {};
  for (const ch of channels) {
    if (typeof ch === "string" && ch.trim()) subs[ch] = {};
  }
  if (!Object.keys(subs).length) throw new Error("no valid channels");
  const iat = Math.floor(Date.now() / 1000);
  return signHS256({ sub: String(userId), subs, iat }, exp);
}

/**
 * Tạo subscription token cho 1 kênh
 */
async function createSubscriptionToken(userId, channel, exp = DEFAULT_TOKEN_TTL) {
  if (!userId) throw new Error("userId required");
  if (!channel) throw new Error("channel required");
  const iat = Math.floor(Date.now() / 1000);
  return signHS256({ sub: String(userId), channel, iat }, exp);
}

module.exports = {
  createConnectionToken,
  createConnectionTokenWithSubs,
  createSubscriptionToken,
};
