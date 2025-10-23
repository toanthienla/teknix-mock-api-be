// src/routes/notifications.routes.js
const express = require("express");
const auth = require("../middlewares/authMiddleware"); // middleware gắn req.user từ token

/**
 * Factory tạo router cho notifications
 * Cách mount trong app.js:
 *   const createNotificationsRoutes = require("./src/routes/notifications.routes");
 *   app.use("/", createNotificationsRoutes());
 */
function NotificationsRoutes() {
  const router = express.Router();

  // ------------------------------------------------------------
  // ÁP QUYỀN CHO TOÀN BỘ ROUTES BÊN DƯỚI
  // - Yêu cầu user đăng nhập (có token hợp lệ)
  // - req.user.id sẽ là user hiện tại
  // ------------------------------------------------------------
  router.use(auth);

  // ====================================================================================
  // GET /notifications?user_id=...&is_read=true|false
  // - Trả về TẤT CẢ notifications của user hiện tại (không phân trang)
  // - Nếu có ?user_id=... thì CHỈ cho phép bằng đúng req.user.id (tránh xem của người khác)
  // - Nếu có ?is_read=true|false thì lọc theo trạng thái đã đọc
  // - Sắp xếp: created_at DESC (mới nhất trước)
  // ====================================================================================
  router.get("/notifications", async (req, res) => {
    try {
      const currentUserId = req.user?.id;
      if (!currentUserId) return res.status(401).json({ message: "Unauthorized" });

      // --- user_id filter (tuỳ chọn) ---
      const qUserId = req.query.user_id != null ? Number(req.query.user_id) : null;
      if (qUserId != null && (!Number.isInteger(qUserId) || qUserId <= 0)) {
        return res.status(400).json({ message: "Invalid user_id" });
      }
      // Chỉ cho phép xem của chính mình
      if (qUserId != null && qUserId !== currentUserId) {
        return res.status(403).json({ message: "Forbidden" });
      }
      const userId = qUserId ?? currentUserId;

      // --- is_read filter (tuỳ chọn) ---
      let isReadFilter = null;
      if (typeof req.query.is_read === "string") {
        if (req.query.is_read === "true") isReadFilter = true;
        else if (req.query.is_read === "false") isReadFilter = false;
        else return res.status(400).json({ message: "Invalid is_read (use true|false)" });
      }

      // --- build WHERE ---
      const where = ["user_id = $1"];
      const params = [userId];
      if (isReadFilter !== null) {
        where.push(`is_read = $${params.length + 1}`);
        params.push(isReadFilter);
      }
      const whereSql = "WHERE " + where.join(" AND ");

      // --- query ---
      // Join to project_request_logs -> endpoints to derive is_stateful if notifications.is_stateful is null
      const { rows } = await req.db.stateless.query(
        `
      SELECT
        n.id,
        n.project_request_log_id,
        n.endpoint_id,
        n.user_id,
        COALESCE(n.is_stateful, e.is_stateful, FALSE) AS is_stateful,
        n.is_read,
        n.created_at,
        prl.request_method,
        prl.request_path
      FROM notifications n
      LEFT JOIN project_request_logs prl ON prl.id = n.project_request_log_id
      LEFT JOIN endpoints e ON e.id = prl.endpoint_id
      ${whereSql}
      ORDER BY n.created_at DESC
      `,
        params
      );

      return res.json(rows);
    } catch (e) {
      console.error("GET /notifications error:", e);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // ====================================================================================
  // PUT /notifications/bulk-read
  // - Đánh dấu đã đọc theo lô cho CHÍNH user hiện tại
  // - Body: { "ids": [1,2,3] }  (mảng số nguyên dương)
  // - Chỉ update các notification có user_id = req.user.id
  // - ĐẶT ROUTE NÀY TRƯỚC /:id để tránh bị "nuốt route"
  // ====================================================================================
  router.put("/notifications/bulk-read", async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const parsed = ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
      if (parsed.length === 0) {
        return res.status(400).json({ message: 'Body must be { "ids": [<int>, ...] }' });
      }

      const { rowCount } = await req.db.stateless.query(
        `
        UPDATE notifications
           SET is_read = TRUE
         WHERE id = ANY($1::int[])
           AND user_id = $2
        `,
        [parsed, userId]
      );

      return res.json({ updated: rowCount, ids: parsed });
    } catch (e) {
      console.error("PUT /notifications/bulk-read error:", e);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // ====================================================================================
  // PUT /notifications/mark-all-read?project_id=5 (project_id là tuỳ chọn)
  // - Đánh dấu đã đọc TẤT CẢ các notification CHƯA ĐỌC của user hiện tại
  // - Nếu có ?project_id=..., chỉ đánh dấu các noti thuộc project đó (join qua project_request_logs)
  // - Không cần body
  // ====================================================================================
  router.put("/notifications/mark-all-read", async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const projectId = req.query.project_id != null ? Number(req.query.project_id) : null;
      if (req.query.project_id != null && (!Number.isInteger(projectId) || projectId <= 0)) {
        return res.status(400).json({ message: "Invalid project_id" });
      }

      let result;
      if (projectId) {
        // Mark-all theo user + project
        result = await req.db.stateless.query(
          `
          UPDATE notifications n
             SET is_read = TRUE
          FROM project_request_logs prl
          WHERE n.project_request_log_id = prl.id
            AND n.is_read = FALSE
            AND n.user_id = $1
            AND prl.project_id = $2
          `,
          [userId, projectId]
        );
      } else {
        // Mark-all theo user
        result = await req.db.stateless.query(
          `
          UPDATE notifications
             SET is_read = TRUE
           WHERE is_read = FALSE
             AND user_id = $1
          `,
          [userId]
        );
      }

      return res.json({ updated: result.rowCount, user_id: userId, project_id: projectId ?? null });
    } catch (e) {
      console.error("PUT /notifications/mark-all-read error:", e);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // ====================================================================================
  // DELETE /notifications/read
  // - Xoá TẤT CẢ notifications đã đọc (is_read = TRUE) của CHÍNH user hiện tại
  // - Không cần body, không filter project
  // - ĐẶT route này TRƯỚC /notifications/:id để tránh bị "nuốt route"
  // ====================================================================================
  router.delete("/notifications/read", async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const result = await req.db.stateless.query(
        `
      DELETE FROM notifications
       WHERE user_id = $1
         AND is_read = TRUE
      `,
        [userId]
      );

      // rowCount = số bản ghi đã xoá
      return res.json({ deleted: result.rowCount });
    } catch (e) {
      console.error("DELETE /notifications/read error:", e);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // ====================================================================================
  // PUT /notifications/:id
  // - Đánh dấu đã đọc MỘT notification
  // - Body: { "is_read": true }
  // - Bảo toàn quyền: chỉ cho phép update notification của user hiện tại
  // - ĐẶT SAU CÙNG (sau bulk-read & mark-all-read) để không chặn các route kia
  // ====================================================================================
  router.put("/notifications/:id", async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: "Invalid notification id" });
      }

      const want = req.body?.is_read;
      if (want !== true) {
        return res.status(400).json({ message: 'Body must be { "is_read": true }' });
      }

      // Kiểm tra quyền sở hữu trước khi cập nhật
      const check = await req.db.stateless.query(`SELECT user_id FROM notifications WHERE id = $1`, [id]);
      if (check.rowCount === 0) {
        return res.status(404).json({ message: "Notification not found" });
      }
      if (Number(check.rows[0].user_id) !== Number(userId)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      // Cập nhật
      const { rows } = await req.db.stateless.query(
        `
        UPDATE notifications
           SET is_read = TRUE
         WHERE id = $1
         RETURNING id, project_request_log_id, endpoint_id, user_id, is_stateful, is_read, created_at
        `,
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ message: "Notification not found" });
      }
      return res.json(rows[0]);
    } catch (e) {
      console.error("PUT /notifications/:id error:", e);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // ====================================================================================
  // DELETE /notifications/:id
  // - Xóa 1 notification theo id
  // - Chỉ cho phép xóa notification thuộc về CHÍNH user đang đăng nhập
  // ====================================================================================
  router.delete("/notifications/:id", async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: "Invalid notification id" });
      }

      // Kiểm tra quyền sở hữu
      const check = await req.db.stateless.query(`SELECT user_id FROM notifications WHERE id = $1`, [id]);
      if (check.rowCount === 0) {
        return res.status(404).json({ message: "Notification not found" });
      }
      if (Number(check.rows[0].user_id) !== Number(userId)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      // Xóa
      const del = await req.db.stateless.query(`DELETE FROM notifications WHERE id = $1`, [id]);

      return res.json({ deleted: del.rowCount, id });
    } catch (e) {
      console.error("DELETE /notifications/:id error:", e);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  return router;
}

module.exports = NotificationsRoutes;
