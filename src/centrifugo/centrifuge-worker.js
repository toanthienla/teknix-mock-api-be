require("dotenv").config();
const { Centrifuge } = require("centrifuge");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
const WS_URL = need("CENTRIFUGO_WS");
const SECRET = need("CENTRIFUGO_HMAC_SECRET");
const CHANNEL = need("CENTRIFUGO_SUB_CHANNEL");
const WORKERID = process.env.CENTRIFUGO_WORKER_ID || "node-worker-1";
const TOKEN_EXP_SECONDS = Number(process.env.CENTRIFUGO_TOKEN_EXP_SECONDS || 7200);
const TOKEN_REFRESH_BEFORE = Number(process.env.CENTRIFUGO_TOKEN_REFRESH_BEFORE || 30);

// Polyfill WebSocket cho môi trường Node
global.WebSocket = WebSocket;

// 1) Ký token JWT cho client kết nối Centrifugo
// By default we issue a token that lives 2 hours (7200s) unless CENTRIFUGO_TOKEN_EXP_SECONDS is set.
// The worker will automatically refresh (reconnect with a new token) shortly before expiry.
function signToken() {
  const configuredExp = Number(TOKEN_EXP_SECONDS || 0);
  const now = Math.floor(Date.now() / 1000);
  // default: 2 hours
  const defaultExp = now + 2 * 60 * 60;
  const exp = configuredExp > 0 ? now + configuredExp : defaultExp;

  const payload = {
    sub: WORKERID,
    exp,
    channels: [CHANNEL],
  };
  return jwt.sign(payload, SECRET, { algorithm: "HS256" });
}

// Worker lifecycle with exp-based auto-refresh
let centrifuge = null;
let sub = null;
let refreshTimer = null;
let shuttingDown = false;

function scheduleRefresh(token) {
  // buffer seconds before expiry to refresh
  const bufferSeconds = Number(TOKEN_REFRESH_BEFORE || 30);
  try {
    const decoded = jwt.decode(token);
    const exp = decoded && decoded.exp ? Number(decoded.exp) : null;
    if (!exp) return;
    const now = Math.floor(Date.now() / 1000);
    let wait = exp - now - bufferSeconds;
    if (wait < 5) wait = 5; // minimum wait
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      console.log("[worker] token nearing expiry, refreshing connection...");
      refreshConnection().catch((e) => console.error("[worker] refresh failed", e));
    }, wait * 1000);
    console.log(`[worker] scheduled refresh in ${wait}s (buffer ${bufferSeconds}s)`);
  } catch (e) {
    console.warn("[worker] failed to schedule refresh", e?.message || e);
  }
}

async function startClient() {
  const token = signToken();
  centrifuge = new Centrifuge(WS_URL, { token });

  centrifuge.on("connected", (ctx) => console.log("[worker] connected", ctx));
  centrifuge.on("disconnected", (ctx) => console.log("[worker] disconnected", ctx));
  centrifuge.on("error", (err) => console.error("[worker] error", err));

  sub = centrifuge.subscribe(CHANNEL);
  sub.on("publication", (ctx) => {
    console.log("[worker] GOT MESSAGE:", JSON.stringify(ctx.data));
  });
  sub.on("join", (ctx) => console.log("[worker] join", ctx));
  sub.on("leave", (ctx) => console.log("[worker] leave", ctx));

  await centrifuge.connect();

  try {
    await sub.subscribe();
    console.log(`[worker] subscribed to ${CHANNEL}`);
  } catch (e) {
    console.error("[worker] subscribe failed", e?.message || e);
  }

  // schedule refresh based on token exp
  scheduleRefresh(token);
}

async function stopClient() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  try {
    if (sub) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  } catch (e) {
    console.error("[worker] error unsubscribing", e);
  }
  try {
    if (centrifuge) {
      await centrifuge.disconnect().catch(() => {});
      centrifuge = null;
    }
  } catch (e) {
    console.error("[worker] error disconnecting", e);
  }
}

async function refreshConnection() {
  if (shuttingDown) return;
  try {
    await stopClient();
  } catch (e) {
    console.error("[worker] error stopping client for refresh", e);
  }
  try {
    await startClient();
    console.log("[worker] refresh complete");
  } catch (e) {
    console.error("[worker] refresh connect failed", e);
  }
}

async function main() {
  try {
    await startClient();

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("[worker] shutting down centrifuge connection...");
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      await stopClient();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (e) {
    console.error("[worker] fatal", e);
    process.exit(1);
  }
}

main();
