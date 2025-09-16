// Mock runtime router
// ------------------------------------------------------------
// Mục đích: Bắt tất cả request còn lại (sau các route quản trị)
// và trả về dữ liệu mô phỏng từ DB theo bảng endpoints + endpoint_responses.
//
// Luồng xử lý tổng quát:
// 1) Lấy HTTP method hiện tại (GET/POST/PUT/DELETE,...)
// 2) Query tất cả endpoint có method tương ứng từ bảng endpoints
// 3) Dùng path-to-regexp để so khớp pattern endpoint.path với req.path
//    - Hỗ trợ dynamic params: ví dụ '/users/:id'
//    - strict: true, end: true => khớp chính xác (nhạy cảm dấu '/')
// 4) Nếu tìm thấy endpoint phù hợp, lấy endpoint_responses tương ứng
//    và chọn 1 response để trả về (ưu tiên is_default; fallback: mới nhất)
// 5) Trả về body (JSON nếu là object, còn lại send text)
//


const express = require('express');
const db = require('../config/db');
const { match } = require('path-to-regexp');
const router = express.Router();

// Bộ so khớp path-to-regexp có cache đơn giản để tránh tạo lại matcher nhiều lần
// key: pattern string, value: match function
const matcherCache = new Map();

/**
 * Tạo/đọc matcher cho 1 pattern endpoint.path
 * Ví dụ pattern: '/users/:id' sẽ khớp '/users/42'
 * - strict: true => phân biệt có/không có dấu '/' ở cuối
 * - end: true => phải khớp toàn bộ path (không cho phép phần dư)
 */
function getMatcher(pattern) {
  let fn = matcherCache.get(pattern);
  if (!fn) {
    fn = match(pattern, { decode: decodeURIComponent, strict: true, end: true });
    matcherCache.set(pattern, fn);
  }
  return fn;
}

// Catch-all sau các route admin; tìm endpoint tương ứng và trả mock response từ DB
// Đặt router.use ở cuối app để không “nuốt” các route quản trị phía trên.

router.use(async (req, res, next) => {
  try {
    const method = req.method.toUpperCase();

    // 1) Lấy danh sách endpoint theo method hiện tại
    const { rows: endpoints } = await db.query(
      'SELECT id, method, path FROM endpoints WHERE UPPER(method) = $1 ORDER BY id DESC',
      [method]
    );

    // 2) Chọn endpoint đầu tiên có path khớp req.path
    //    Lưu ý: nếu có nhiều endpoint trùng method + path, endpoint có id cao hơn (mới hơn)
    //    sẽ được duyệt trước do ORDER BY id DESC.
    const ep = endpoints.find((e) => {
      try {
        const fn = getMatcher(e.path);
        return Boolean(fn(req.path));
      } catch (_) {
        return false;
      }
    });
    if (!ep) return next();

    // 3) Ưu tiên response mặc định (is_default = true), nếu không có thì lấy bản mới nhất
    // TODO (tùy chọn): Để đồng bộ với schema mới có priority, có thể đổi ORDER BY như sau:
    // ORDER BY priority DESC NULLS LAST, is_default DESC, updated_at DESC, created_at DESC
    // và thêm cột delay_ms để mô phỏng độ trễ:
    // if (r.delay_ms) await new Promise(r => setTimeout(r, r.delay_ms));
    const { rows: responses } = await db.query(
      `SELECT id, endpoint_id, name, status_code, response_body, is_default, created_at, updated_at
       FROM endpoint_responses
       WHERE endpoint_id = $1
       ORDER BY is_default DESC, updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [ep.id]
    );

    if (responses.length === 0) {
      return res
        .status(501)
        .json({ error: { message: 'No response configured for this endpoint' } });
    }

    // 4) Trả về nội dung response:
    // - Nếu response_body là object => trả JSON
    // - Nếu là string/empty => send text/empty string
    const r = responses[0];
    const status = r.status_code || 200;
    const body = r.response_body ?? null;

    if (body && typeof body === 'object') return res.status(status).json(body);
    return res.status(status).send(body ?? '');
  } catch (err) {
    // Cho middleware xử lý lỗi chung xử lý tiếp
    return next(err);
  }
});

module.exports = router;
