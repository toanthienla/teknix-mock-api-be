//const db = require('../config/db');

// Service xử lý dữ liệu cho bảng endpoint_responses
// Quy ước chính:
// - Mỗi endpoint có thể có nhiều response khác nhau (theo condition/priority)
// - Chỉ duy nhất 1 response mặc định (is_default = true) cho mỗi endpoint tại một thời điểm
// - priority: số càng lớn ưu tiên càng cao (được xét trước)

// Lấy tất cả response theo endpoint_id
// Tham số: endpointId (number)
// Trả về: danh sách response kèm đầy đủ trường, sắp xếp theo priority -> default -> thời gian
async function getByEndpointId(dbPool, endpointId) {
  const { rows } = await dbPool.query(
    `SELECT id, endpoint_id, name, status_code, response_body, condition,
            priority, is_default, delay_ms, proxy_url, proxy_method, created_at, updated_at
     FROM endpoint_responses
     WHERE endpoint_id = $1
     ORDER BY priority DESC NULLS LAST, is_default DESC, updated_at DESC, created_at DESC`,
    [endpointId]
  );
  return rows;
}

// Lấy chi tiết 1 response theo id
// Tham số: id (number)
// Trả về: object response hoặc null nếu không tồn tại
async function getById(dbPool, id) {
  const { rows } = await dbPool.query(
    `SELECT id, endpoint_id, name, status_code, response_body, condition,
            priority, is_default, delay_ms, proxy_url, proxy_method, created_at, updated_at
     FROM endpoint_responses
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

// Tạo mới response cho một endpoint
// Tham số: object gồm { endpoint_id, name, status_code, response_body={}, condition={}, is_default=false, delay_ms=0 }
// Business:
//  - Nếu là response đầu tiên của endpoint → ép is_default = true
//  - Đảm bảo chỉ 1 response mặc định/endpoint: nếu tạo mới default → unset các default khác
//  - priority tự động = MAX(priority) + 1 (bắt đầu từ 1)
// Trả về: response vừa tạo (đầy đủ trường)
async function create(dbPool, { endpoint_id, name, status_code, response_body = {}, condition = {}, is_default = false, delay_ms = 0 }) {
  // Determine if this is the first response for the endpoint and the next priority
  const { rows: stats } = await dbPool.query(
    `SELECT COUNT(*)::int AS total, COALESCE(MAX(priority), 0)::int AS max_priority
     FROM endpoint_responses WHERE endpoint_id = $1`,
    [endpoint_id]
  );

  const total = stats[0]?.total || 0; // tổng số response hiện có
  const nextPriority = (stats[0]?.max_priority || 0) + 1; // priority kế tiếp
  const willBeDefault = total === 0 ? true : Boolean(is_default); // response đầu tiên luôn là default

  // Ensure only one default per endpoint
  if (willBeDefault) {
    await dbPool.query("UPDATE endpoint_responses SET is_default = FALSE WHERE endpoint_id = $1", [endpoint_id]);
  }

  const { rows } = await dbPool.query(
    `INSERT INTO endpoint_responses (endpoint_id, name, status_code, response_body, condition, priority, is_default, delay_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0))
     RETURNING id, endpoint_id, name, status_code, response_body, condition, priority, is_default, delay_ms, created_at, updated_at`,
    [endpoint_id, name, status_code, response_body, condition, nextPriority, willBeDefault, delay_ms]
  );
  return rows[0];
}

// Cập nhật 1 response theo id
// Tham số: id (number), object cập nhật { name, status_code, response_body, condition, is_default, delay_ms }
// Business:
//  - Nếu is_default = true → unset is_default các response khác cùng endpoint
//  - Không thay đổi priority ở API này (chỉ update dữ liệu)
//  - Nếu proxy_url/proxy_method null → xóa cấu hình proxy
// Trả về: response sau khi cập nhật hoặc null nếu không tồn tại
async function update(dbPool, dbPoolfull, id, { name, status_code, response_body, condition, is_default, delay_ms, proxy_url = null, proxy_method = null }) {
  // Xác định response thuộc stateful hay stateless
  const isStatefull = await checkIsStatefull(dbPool, dbPoolfull, id);

  if (!isStatefull) {
    //  Nhánh Stateless
    let endpointId;
    if (typeof is_default !== "undefined") {
      const current = await getById(dbPool, id);
      endpointId = current?.endpoint_id;
      if (!current) return null;
      if (is_default === true && endpointId) {
        await dbPool.query("UPDATE endpoint_responses SET is_default = FALSE WHERE endpoint_id = $1 AND id <> $2", [endpointId, id]);
      }
    }

    const { rows } = await dbPool.query(
      `UPDATE endpoint_responses
       SET name = COALESCE($1, name),
           status_code = COALESCE($2, status_code),
           response_body = COALESCE($3, response_body),
           condition = COALESCE($4, condition),
           is_default = COALESCE($5, is_default),
           delay_ms = COALESCE($6, delay_ms),
           proxy_url = $7,
           proxy_method = $8,
           updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [name, status_code, response_body, condition, is_default, delay_ms, proxy_url, proxy_method, id]
    );

    return rows[0] || null;
  } else {
    //  Nhánh Stateful — giữ luật cũ:
    //  1) Nếu endpoint.method = 'GET' và response.status_code = 200:
    //     - CHO phép sửa: name, delay_ms
    //     - KHÔNG cho sửa: response_body
    //  2) Các response stateful khác: cho sửa name, response_body, delay_ms
    //  3) status_code: luôn cố định (không update)

    // Lấy response + method endpoint + origin info
    const {
      rows: [row],
    } = await dbPoolfull.query(
      `SELECT rf.id, rf.origin_id, rf.name, rf.status_code, rf.response_body, rf.delay_ms,
            ef.method,
            ef.id AS endpoint_ful_id,
            ef.origin_id AS endpoint_origin_id
       FROM endpoint_responses_ful rf
       JOIN endpoints_ful ef ON rf.endpoint_id = ef.id
      WHERE rf.origin_id = $1 OR rf.id = $1
      LIMIT 1`,
      [id]
    );
    if (!row) throw new Error("Response not found in stateful DB");

    const isGet200 = String(row.method).toUpperCase() === "GET" && Number(row.status_code) === 200;

    // status_code là immutable: bỏ qua bất kỳ giá trị client gửi lên
    const nextName = typeof name !== "undefined" ? name : row.name;
    const nextDelay = typeof delay_ms !== "undefined" ? delay_ms : row.delay_ms;

    if (!isGet200) {
      // Cho phép sửa body ở các response stateful khác
      const nextBody = typeof response_body !== "undefined" ? response_body : row.response_body;

      const { rows: up } = await dbPoolfull.query(
        `UPDATE endpoint_responses_ful
          SET name = $1,
              response_body = $2,
              delay_ms = $3,
              updated_at = NOW()
        WHERE origin_id = $4 OR id = $4
        RETURNING id, origin_id, name, status_code, response_body, delay_ms, created_at, updated_at`,
        [nextName, nextBody, nextDelay, id]
      );

      const u = up[0];
      if (!u) return null;

      // Map id/endpoint_id về "thế giới stateless" để tránh nhầm
      return {
        id: u.origin_id || u.id,
        endpoint_id: row.endpoint_origin_id || row.endpoint_ful_id,
        name: u.name,
        status_code: row.status_code, // immutable theo luật hiện tại
        response_body: u.response_body,
        delay_ms: u.delay_ms,
        created_at: u.created_at,
        updated_at: u.updated_at,
      };
    } else {
      // GET 200: không cho sửa body
      const { rows: up } = await dbPoolfull.query(
        `UPDATE endpoint_responses_ful
          SET name = $1,
              delay_ms = $2,
              updated_at = NOW()
        WHERE origin_id = $3 OR id = $3
        RETURNING id, origin_id, name, status_code, response_body, delay_ms, created_at, updated_at`,
        [nextName, nextDelay, id]
      );

      const u = up[0];
      if (!u) return null;

      // Map id/endpoint_id về "thế giới stateless" để tránh nhầm
      return {
        id: u.origin_id || u.id,
        endpoint_id: row.endpoint_origin_id || row.endpoint_ful_id,
        name: u.name,
        status_code: row.status_code, // immutable
        response_body: u.response_body, // không thay đổi trong GET 200
        delay_ms: u.delay_ms,
        created_at: u.created_at,
        updated_at: u.updated_at,
      };
    }
  }
}

// Hàm check nhanh xem response thuộc endpoint stateful hay không
async function checkIsStatefull(dbPool, dbPoolfull, responseId) {
  // 1) Nếu id tồn tại ở stateless => KHÔNG phải stateful
  const { rows: s } = await dbPool.query(`SELECT 1 FROM endpoint_responses WHERE id = $1 LIMIT 1`, [responseId]);
  if (s.length > 0) return false;

  // 2) Không có ở stateless -> tra stateful theo origin_id trước, rồi tới id
  const { rows: f } = await dbPoolfull.query(
    `SELECT ef.is_active
       FROM endpoint_responses_ful rf
       JOIN endpoints_ful ef ON ef.id = rf.endpoint_id
      WHERE rf.origin_id = $1 OR rf.id = $1
      LIMIT 1`,
    [responseId]
  );

  return f[0]?.is_active === true;
}

// Cập nhật danh sách priority cho nhiều response
// Tham số: items = [{ id, endpoint_id, priority }, ...]
// Lưu ý: không tự reorder liên tục; giá trị priority sẽ được set theo input
// Trả về: mảng các bản ghi { id, endpoint_id, priority } đã cập nhật thành công
async function updatePriorities(dbPool, items) {
  // items: [{ id, endpoint_id, priority }]
  if (!Array.isArray(items) || items.length === 0) return [];
  // có thể tùy chọn xác thực cùng một endpoint_id; tiến hành cập nhật theo như đã cung cấp
  const results = [];
  for (const it of items) {
    const { id, endpoint_id, priority } = it;
    const { rows } = await dbPool.query(
      `UPDATE endpoint_responses
       SET priority = $1, updated_at = NOW()
       WHERE id = $2 AND endpoint_id = $3
       RETURNING id, endpoint_id, priority`,
      [priority, id, endpoint_id]
    );
    if (rows[0]) results.push(rows[0]);
  }
  return results;
}

// Xóa 1 response theo id
// Tham số: id (number)
// Trả về: true sau khi xóa
async function remove(dbPool, id) {
  await dbPool.query("DELETE FROM endpoint_responses WHERE id = $1", [id]);
  return true;
}

// Đặt 1 response làm mặc định
// Tham số: id (number)
// Business:
//  - Unset is_default của tất cả response cùng endpoint
//  - Set is_default = true cho response có id tương ứng
// Trả về: danh sách rút gọn các response của endpoint đó: [{ id, endpoint_id, is_default }, ...]
async function setDefault(dbPool, id) {
  // Đảm bảo phản hồi mục tiêu tồn tại và lấy endpoint_id của nó
  const current = await getById(dbPool, id);
  if (!current) return [];
  const endpointId = current.endpoint_id;

  // Bỏ các mục khác, sau đó đặt mục này
  await dbPool.query("UPDATE endpoint_responses SET is_default = FALSE WHERE endpoint_id = $1", [endpointId]);
  await dbPool.query("UPDATE endpoint_responses SET is_default = TRUE, updated_at = NOW() WHERE id = $1", [id]);

  // Trả về danh sách tóm tắt cho điểm cuối đó
  const { rows } = await dbPool.query("SELECT id, endpoint_id, is_default FROM endpoint_responses WHERE endpoint_id = $1 ORDER BY id ASC", [endpointId]);
  return rows;
}

// Public API export của service
module.exports = {
  getByEndpointId,
  getById,
  create,
  update,
  updatePriorities,
  remove,
  setDefault,
};
