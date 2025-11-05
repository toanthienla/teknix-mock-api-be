const http = require("http");
const app = require("./app");
const { checkConnections, pool } = require("./config/db");
// WS manager nằm ở thư mục gốc "WS", không phải "src/ws"
const { initWs } = require("./utils/ws-manager");
const PORT = process.env.PORT || 3000;

(async () => {
  await checkConnections();
  const server = http.createServer(app);

  // Khởi tạo WS (noServer) để tự kiểm soát path / gate DB
  initWs({ server, pool });

  server.listen(PORT, () => {
    console.log();
    console.log(`http://localhost:${PORT}`);
  });
})();
