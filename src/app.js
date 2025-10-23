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
// const notifyRoutes = require('./centrifugo/notify.routes'); // đã require trực tiếp ở dưới bằng app.use('/api', ...)

const app = express();

// ---------------------------------------------
// 1) CORS — ĐẶT TRƯỚC MỌI ROUTE
//    Cho phép gọi từ HTML test (http://127.0.0.1:5500) và FE (localhost/127.0.0.1:3000)
//    Nếu muốn mở hết trong dev: tạm dùng app.use(cors()) là nhanh nhất.
// ---------------------------------------------
const allowedOrigins = new Set([
  "http://127.0.0.1:5500", // Live Server
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://localhost:8080",
]);

app.use(
  require("cors")({
    origin: (origin, cb) => {
      // Cho phép request không có Origin (Postman/curl)
      if (!origin) return cb(null, true);
      // Cho phép mọi localhost:* trong dev
      if (origin.startsWith("http://localhost:")) return cb(null, true);
      // Whitelist cụ thể
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);

// const allowedOrigins = [
//   "http://localhost:5173",
//   "http://localhost:3000",
//   // FE React (nếu dùng localhost)
//   "http://127.0.0.1:3000", // FE React (nếu dùng 127.0.0.1)
//   "http://localhost:5173", // Vite
//   "http://localhost:8080", // Một số dev servers khác
// ];

// ---------------------------------------------
// 2) Parsers
// ---------------------------------------------
app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------
// 3) Static assets (nếu cần phục vụ file tĩnh từ /public)
// ---------------------------------------------
app.use(express.static(path.join(__dirname, "..", "public")));
// app.use(express.static('public')); // Cách viết ngắn nếu muốn

// ---------------------------------------------
// 4) Centrifugo helpers (đặt sau CORS để không bị chặn)
//    - /centrifugo/conn-token
//    - /centrifugo/sub-token
// ---------------------------------------------
app.use(centrifugoTokenRoutes);

// ---------------------------------------------
// 5) Centrifugo auth/publish HTTP endpoints dưới /api
//    (giữ nguyên như code cũ của bạn)
// ---------------------------------------------
app.use("/api", require("./centrifugo/centrifugo-auth.routes"));
app.use("/api", require("./centrifugo/notify.routes"));

// ---------------------------------------------
// 6) Inject DB pools vào req (để các routes phía sau dùng được)
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
// 8) Các routes cũ của dự án (giữ thứ tự tương đối cũ)
// ---------------------------------------------
const workspaceRoutes = require("./routes/workspace.routes");
const projectRoutes = require("./routes/project.routes");
const endpointRoutes = require("./routes/endpoint.routes");
const endpointResponseRoutes = require("./routes/endpoint_response.routes");
const folderRoutes = require("./routes/folder.routes");
const projectRequestLogRoutes = require("./routes/project_request_log.routes");

const mockRoutes = require("./routes/mock.routes"); // stateless
const statefulRoutes = require("./routes/stateful.routes"); // API quản trị stateful (không phải handler chính)
// const adminResponseLogger = require('./middlewares/adminResponseLogger'); // chưa thấy dùng ở đây
const createNotificationsRoutes = require("./routes/notifications.routes");

// Mount các nhóm chính
app.use("/workspaces", workspaceRoutes);
app.use("/projects", projectRoutes);
app.use("/endpoints", endpointRoutes);
app.use("/folders", folderRoutes);
app.use(mockRoutes);

// Các route dùng path gốc (giữ như cũ để không phá flow hiện tại)
app.use("/", endpointResponseRoutes);
app.use("/", statefulRoutes);
app.use("/", createNotificationsRoutes());

// Logs stateless/stateful theo module riêng
app.use("/project_request_logs", projectRequestLogRoutes);

// ---------------------------------------------
// 9) Universal handler — ĐẶT CUỐI CÙNG
//    theo triết lý: static → mock.routes → statefulHandler → universalHandler
// ---------------------------------------------
app.use("/:workspace/:project", auth, require("./routes/universalHandler"));

// ---------------------------------------------
// 10) Health-check đơn giản (khuyến nghị thêm để debug nhanh port/listen)
//      - Có thể xóa sau khi ổn định
// ---------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

module.exports = app;
