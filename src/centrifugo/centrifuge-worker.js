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
function signToken() {
  if (!SECRET) {
    throw new Error("Missing CENTRIFUGO_HMAC_SECRET in env");
  }
  const payload = {
    sub: WORKERID,
    exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1 giờ
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
  centrifuge.on("publication", (ctx) => {
    if (ctx.channel === CHANNEL) {
      console.log("[worker] GOT MESSAGE:", JSON.stringify(ctx.data));
    }
  });

  //  connect trước, rồi gọi sub.subscribe() đúng 1 lần
  await centrifuge.connect();
  // sub.subscribe(); // gọi MỘT lần cho cả vòng đời process
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
