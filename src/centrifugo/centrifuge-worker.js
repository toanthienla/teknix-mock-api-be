require("dotenv").config();
const { Centrifuge } = require("centrifuge");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");

// Polyfill WebSocket cho môi trường Node
global.WebSocket = WebSocket;

const WS_URL = process.env.CENTRIFUGO_WS || "ws://127.0.0.1:18080/connection/websocket";
const SECRET = process.env.CENTRIFUGO_HMAC_SECRET;
const CHANNEL = process.env.CENTRIFUGO_SUB_CHANNEL || "notification#mock_logging";
const WORKERID = process.env.CENTRIFUGO_WORKER_ID || "node-worker";

// 1) Ký token JWT cho client kết nối Centrifugo
// By default we issue a very long-lived token so the worker stays connected while
// the server process runs. You can override lifetime with CENTRIFUGO_TOKEN_EXP_SECONDS.
function signToken() {
  if (!SECRET) {
    throw new Error("Missing CENTRIFUGO_HMAC_SECRET in env");
  }
  const now = Math.floor(Date.now() / 1000);
  const configuredExp = Number(process.env.CENTRIFUGO_TOKEN_EXP_SECONDS || "0");
  // default: ~10 years (server-lifetime token)
  const defaultExp = now + 10 * 365 * 24 * 60 * 60;
  const exp = configuredExp > 0 ? now + configuredExp : defaultExp;

  const payload = {
    sub: WORKERID,
    exp,
    channels: [CHANNEL],
  };
  return jwt.sign(payload, SECRET, { algorithm: "HS256" });
}

async function main() {
  const token = signToken();
  const centrifuge = new Centrifuge(WS_URL, { token });

  // Log lifecycle
  centrifuge.on("connected", (ctx) => console.log("[worker] connected", ctx));
  centrifuge.on("disconnected", (ctx) => console.log("[worker] disconnected", ctx));
  centrifuge.on("error", (err) => console.error("[worker] error", err));

  // 2) Chuẩn bị subscription (tạo trước)
  // create subscription and handle publications
  const sub = centrifuge.subscribe(CHANNEL);
  sub.on("publication", (ctx) => {
    console.log("[worker] GOT MESSAGE:", JSON.stringify(ctx.data));
  });
  sub.on("join", (ctx) => console.log("[worker] join", ctx));
  sub.on("leave", (ctx) => console.log("[worker] leave", ctx));

  // connect once for the process lifetime
  await centrifuge.connect();

  // Ensure the subscription is active
  try {
    await sub.subscribe();
    console.log(`[worker] subscribed to ${CHANNEL}`);
  } catch (e) {
    console.error("[worker] subscribe failed", e?.message || e);
  }

  // Graceful shutdown: disconnect centrifuge when process exits
  const shutdown = async () => {
    try {
      console.log("[worker] shutting down centrifuge connection...");
      await sub.unsubscribe().catch(() => {});
      await centrifuge.disconnect();
    } catch (e) {
      console.error("[worker] error during shutdown", e);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
