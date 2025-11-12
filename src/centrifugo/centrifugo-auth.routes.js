// // src/centrifugo/centrifugo-auth.routes.js
// require("dotenv").config();
// const express = require("express");
// const jwt = require("jsonwebtoken");
// const router = express.Router();

// const HMAC_SECRET = process.env.CENTRIFUGO_HMAC_SECRET;
// if (!HMAC_SECRET) throw new Error("Missing env CENTRIFUGO_HMAC_SECRET");
// const MULTI_TOKEN_TTL_SEC = Number(process.env.CENTRIFUGO_MULTI_TOKEN_TTL_SEC || 3600);

// // Lấy danh sách project của user từ DB; nếu chưa có DB mapping thì cho phép nhận tạm qua query (?project_ids=1,2,3)
// async function getUserProjectIds(db, userId, fallbackCsv) {
//   // Nếu bạn đã có bảng user_projects (user_id, project_id) thì bật đoạn dưới:
//   if (db && typeof db.query === "function") {
//     try {
//       const r = await db.query("SELECT project_id FROM user_projects WHERE user_id = $1", [userId]);
//       return r.rows.map((x) => String(x.project_id));
//     } catch (e) {
//       // Không có bảng? => rơi xuống fallback
//     }
//   }
//   // Fallback: nhận tạm project_ids từ query để test nhanh
//   if (fallbackCsv) {
//     return String(fallbackCsv)
//       .split(",")
//       .map((s) => s.trim())
//       .filter(Boolean);
//   }
//   return [];
// }

// /**
//  * GET /centrifugo/token?user_id=42&project_ids=1,2,3
//  * Trả JWT HS256 với claim `channels`:
//  *   - notification#project_{project_id} (theo danh sách project user có)
//  *   - user_{user_id}#notifications (kênh cá nhân)
//  */
// router.get("/centrifugo/token", async (req, res, next) => {
//   try {
//     const userId = String(req.query.user_id || "user_123");
//     const projectIds = await getUserProjectIds(
//       req.db?.stateless,
//       userId,
//       req.query.project_ids // CSV để test nếu chưa có DB
//     );

//     const channels = [
//       ...projectIds.map((id) => `notification#project_${id}`),
//       `user_${userId}#notifications`,
//       // (tuỳ) còn giai đoạn chuyển đổi có thể giữ thêm kênh cũ:
//       // "notification#mock_logging"
//     ];

//     const payload = {
//       sub: userId,
//       exp: Math.floor(Date.now() / 1000) + MULTI_TOKEN_TTL_SEC,
//       channels,
//     };

//     const token = jwt.sign(payload, HMAC_SECRET, { algorithm: "HS256" });

//     res.json({ token, userId, channels });
//   } catch (e) {
//     next(e);
//   }
// });

// module.exports = router;
