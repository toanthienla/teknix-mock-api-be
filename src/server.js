const http = require("http");
const app = require("./app");
const { checkConnections, pool } = require("./config/db");
const PORT = process.env.PORT || 3000;

(async () => {
  await checkConnections();
  const server = http.createServer(app);

  server.listen(PORT, () => {
    console.log();
    console.log(`http://localhost:${PORT}`);
  });
})();
