// app.js
// ---------------------------------------------
// Khởi tạo app Express với thứ tự middleware hợp lý
// - CORS phải đặt TRƯỚC routes để browser không bị chặn
// - Body parsers & cookie parser trước routes
// - Static routes → mock.routes → statefulHandler → universalHandler (giữ nguyên triết lý của dự án)
// ---------------------------------------------

require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const path = require("path");

const auth = require("./middlewares/authMiddleware");

// === Centrifugo routes (auth/publish/token) ===
const centrifugoTokenRoutes = require("./centrifugo/centrifugo.token.routes");

const app = express();

// ---------------------------------------------
// 1) CORS — Load toàn bộ từ .env
// ---------------------------------------------
const rawCorsOrigins = process.env.CORS_ORIGINS || "";
const allowedOrigins = new Set(
  rawCorsOrigins
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
);

app.use(
  cors({
    origin: (origin, cb) => {
      // Cho phép request không có Origin (Postman, curl)
      if (!origin) return cb(null, true);
      // Whitelist từ .env
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: process.env.CORS_CREDENTIALS === "true",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "X-Proxy-Authorization", "x-proxy-authorization"],
    optionsSuccessStatus: 204,
  })
);

// Log để kiểm tra CORS load đúng
console.log("[CORS] Allowed origins:", [...allowedOrigins]);
console.log("[CORS] Credentials:", process.env.CORS_CREDENTIALS);

// ---------------------------------------------
// 2) Parsers
// ---------------------------------------------
app.use(express.json());
app.use(cookieParser());
const fileUpload = require("express-fileupload");
app.use(fileUpload());
const https = require("https");

// ---------------------------------------------
// 3) Static assets
// ---------------------------------------------
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------------------------------------------
// 4) Centrifugo helpers
// ---------------------------------------------
app.use(centrifugoTokenRoutes);

// ---------------------------------------------
// 5) Centrifugo auth/publish endpoints
// ---------------------------------------------
app.use("/api", require("./centrifugo/centrifugo-auth.routes"));
app.use("/api", require("./centrifugo/notify.routes"));

// ---------------------------------------------
// 6) Inject DB pools vào req
// ---------------------------------------------
const { statelessPool, statefulPool } = require("./config/db");
app.use((req, res, next) => {
  req.db = {
    stateless: statelessPool,
    stateful: statefulPool,
  };
  next();
});

// ---------------------------------------------
// 7) JWT routes (auth / protected)
// ---------------------------------------------
const authRoutes = require("./routes/auth.routes");
const protectedRoutes = require("./routes/protected.routes");
app.use("/auth", authRoutes);
app.use("/protected", protectedRoutes);

// ---------------------------------------------
// 8) Các routes chính
// ---------------------------------------------
const workspaceRoutes = require("./routes/workspace.routes");
const projectRoutes = require("./routes/project.routes");
const endpointRoutes = require("./routes/endpoint.routes");
const endpointResponseRoutes = require("./routes/endpoint_response.routes");
const folderRoutes = require("./routes/folder.routes");
const projectRequestLogRoutes = require("./routes/project_request_log.routes");
const endpointsFulRoutes = require("./routes/endpoints_ful.routes");

const mockRoutes = require("./routes/mock.routes"); // stateless
const statefulRoutes = require("./routes/stateful.routes"); // API quản trị stateful
const createNotificationsRoutes = require("./routes/notifications.routes");

app.use("/workspaces", workspaceRoutes);
app.use("/projects", projectRoutes);
app.use("/endpoints", endpointRoutes);
app.use("/folders", folderRoutes);
app.use("/endpoints_ful", endpointsFulRoutes);

// Routes giữ path gốc cũ
app.use("/", endpointResponseRoutes);
app.use("/", statefulRoutes);
app.use("/", createNotificationsRoutes());

// Logs stateless/stateful
app.use("/project_request_logs", projectRequestLogRoutes);

//Legacy stateless (không prefix) — đặt SAU các route cụ thể
app.use(mockRoutes);

// ---------------------------------------------
// 9) Universal handler — ĐẶT CUỐI CÙNG
// ---------------------------------------------
app.use("/:workspace/:project", auth, require("./routes/universalHandler"));

// ---------------------------------------------
// 10) Health-check
// ---------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

module.exports = app;
