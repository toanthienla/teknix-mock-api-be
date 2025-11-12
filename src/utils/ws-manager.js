// const url = require("url");
// const { WebSocketServer } = require("ws");

// /**
//  * Kênh = `${workspace}/${project}`
//  * Lưu map: channel -> Set<ws>
//  */
// const channels = new Map();

// function parseWsPath(reqUrl) {
//   // Expect: /ws/:workspace/:project
//   const { pathname } = url.parse(reqUrl);
//   const parts = (pathname || "").split("/").filter(Boolean);
//   if (parts.length === 3 && parts[0] === "ws") {
//     return { workspace: parts[1], project: parts[2] };
//   }
//   return null;
// }

// async function isProjectWsEnabled(pool, workspace, project) {
//   // Kiểm tra theo thiết kế: chỉ expose nếu projects.websocket_enabled = true
//   // JOIN workspaces -> projects qua name
//   const sql = `
//     SELECT p.id, p.websocket_enabled
//     FROM projects p
//     JOIN workspaces w ON w.id = p.workspace_id
//     WHERE w.name = $1 AND p.name = $2
//     LIMIT 1
//   `;
//   const { rows } = await pool.query(sql, [workspace, project]);
//   return rows.length > 0 && rows[0].websocket_enabled === true;
// }

// function getChannelKey(workspace, project) {
//   return `${workspace}/${project}`;
// }

// function addClientToChannel(channel, ws) {
//   if (!channels.has(channel)) channels.set(channel, new Set());
//   channels.get(channel).add(ws);
//   ws.__channel = channel; // mark for cleanup
// }

// function removeClient(ws) {
//   if (ws && ws.__channel && channels.has(ws.__channel)) {
//     const set = channels.get(ws.__channel);
//     set.delete(ws);
//     if (set.size === 0) channels.delete(ws.__channel);
//   }
// }

// /**
//  * Broadcast tiện dụng cho bước 3:
//  *   broadcast({ workspace, project, data })
//  */
// function broadcast({ workspace, project, data }) {
//   const channel = getChannelKey(workspace, project);
//   const set = channels.get(channel);
//   if (!set) return 0;
//   const payload = typeof data === "string" ? data : JSON.stringify(data);
//   let count = 0;
//   for (const client of set) {
//     if (client.readyState === 1) {
//       try {
//         client.send(payload);
//         count++;
//       } catch (e) {}
//     }
//   }
//   return count;
// }

// function initWs({ server, pool }) {
//   // noServer: tự xử lý upgrade để gate theo DB
//   const wss = new WebSocketServer({ noServer: true });

//   server.on("upgrade", async (request, socket, head) => {
//     const parsed = parseWsPath(request.url || "");
//     if (!parsed) {
//       socket.destroy();
//       return;
//     }
//     const { workspace, project } = parsed;

//     try {
//       const enabled = await isProjectWsEnabled(pool, workspace, project);
//       if (!enabled) {
//         socket.destroy();
//         return;
//       }
//     } catch (e) {
//       // Nếu lỗi DB, từ chối kết nối để an toàn
//       socket.destroy();
//       return;
//     }

//     wss.handleUpgrade(request, socket, head, (ws) => {
//       const channel = getChannelKey(workspace, project);
//       addClientToChannel(channel, ws);

//       ws.on("close", () => removeClient(ws));
//       ws.on("error", () => removeClient(ws));

//       // Tuỳ ý: gửi chào mừng
//       try {
//         ws.send(JSON.stringify({ ok: true, channel, t: Date.now() }));
//       } catch {}
//     });
//   });

//   // Để bước 3 có thể import broadcast
//   module.exports.broadcast = broadcast;
// }

// module.exports.initWs = initWs;
