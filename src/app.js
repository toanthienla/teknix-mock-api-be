// app.js
const express = require("express");
const cookieParser = require("cookie-parser");
const app = express();
const cors = require("cors");
const auth = require("./middlewares/authMiddleware");
const path = require("path");
const notifyRoutes = require("./centrifugo/notify.routes");

app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:8080"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, "..", "public")));
// app.use(express.static('public')); // nếu không dùng path
app.use("/api", require("./centrifugo/centrifugo-auth.routes"));
app.use("/api", require("./centrifugo/notify.routes"));

// Import DB pools
const { statelessPool, statefulPool } = require("./config/db");

// Inject DB vào request
app.use((req, res, next) => {
  req.db = {
    stateless: statelessPool,
    stateful: statefulPool,
  };
  next();
});

app.use(
  cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000", "http://127.0.0.1:5500", "http://localhost:5173"],
    credentials: true,
  })
);

// ===== IMPORT ROUTES JWT =====
const authRoutes = require("./routes/auth.routes");
const protectedRoutes = require("./routes/protected.routes");

// ===== MOUNT JWT ROUTES =====
app.use("/auth", authRoutes);
app.use("/protected", protectedRoutes);

// ===== ROUTES CŨ TEKNIX =====
const workspaceRoutes = require("./routes/workspace.routes");
const projectRoutes = require("./routes/project.routes");
const endpointRoutes = require("./routes/endpoint.routes");
const endpointResponseRoutes = require("./routes/endpoint_response.routes");
const folderRoutes = require("./routes/folder.routes");
const projectRequestLogRoutes = require("./routes/project_request_log.routes");
const mockRoutes = require("./routes/mock.routes"); // stateless
const statefulRoutes = require("./routes/stateful.routes"); // các API quản trị stateful (không phải handler chính)
const adminResponseLogger = require("./middlewares/adminResponseLogger");

// ⚠️ KHÔNG import statefulHandler trực tiếp để tránh bypass auth
// const statefulHandler = require('./routes/statefulHandler'); // ← remove

app.use("/workspaces", workspaceRoutes);
app.use("/projects", projectRoutes);
app.use("/endpoints", endpointRoutes);
app.use("/folders", folderRoutes);
app.use("/", endpointResponseRoutes);
app.use("/", statefulRoutes);
app.use("/", mockRoutes);

// Các route logs khác
app.use("/project_request_logs", projectRequestLogRoutes);

// ✅ MOUNT UNIVERSAL HANDLER CUỐI CÙNG + CÓ AUTH  // CHANGED
// Mọi request động (/:workspace/:project/...) sẽ đi qua đây, có req.user
// MỌI request dạng /:workspace/:project/... phải đi qua auth -> universalHandler
app.use("/:workspace/:project", auth, require("./routes/universalHandler"));

app.use(notifyRoutes);

module.exports = app;
