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
async function create(
  dbPool,
  {
    endpoint_id,
    name,
    status_code,
    response_body = {},
    condition = {},
    is_default = false,
    delay_ms = 0,
  }
) {
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
    await dbPool.query(
      "UPDATE endpoint_responses SET is_default = FALSE WHERE endpoint_id = $1",
      [endpoint_id]
    );
  }

  const { rows } = await dbPool.query(
    `INSERT INTO endpoint_responses (endpoint_id, name, status_code, response_body, condition, priority, is_default, delay_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0))
     RETURNING id, endpoint_id, name, status_code, response_body, condition, priority, is_default, delay_ms, created_at, updated_at`,
    [
      endpoint_id,
      name,
      status_code,
      response_body,
      condition,
      nextPriority,
      willBeDefault,
      delay_ms,
    ]
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
async function update(
  dbPool,
  dbPoolfull,
  id,
  {
    name,
    status_code,
    response_body,
    condition,
    is_default,
    delay_ms,
    proxy_url,
    proxy_method,
  }
) {
  // Xác định response thuộc stateful hay stateless
  const isStatefull = await checkIsStatefull(dbPool, dbPoolfull, id);

  if (!isStatefull) {
    // ====== Nhánh Stateless ======
    let endpointId;
    if (typeof is_default !== "undefined") {
      const current = await getById(dbPool, id);
      endpointId = current?.endpoint_id;
      if (!current) return null;
      if (is_default === true && endpointId) {
        await dbPool.query(
          "UPDATE endpoint_responses SET is_default = FALSE WHERE endpoint_id = $1 AND id <> $2",
          [endpointId, id]
        );
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
      [
        name,
        status_code,
        response_body,
        condition,
        is_default,
        delay_ms,
        proxy_url,
        proxy_method,
        id,
      ]
    );

    return rows[0] || null;
  } else {
    // ====== Nhánh Stateful ======
    const {
      rows: [response],
    } = await dbPoolfull.query(
      `SELECT * FROM endpoint_responses_ful WHERE id = $1`,
      [id]
    );
    if (!response) {
      throw new Error("Response not found in stateful DB");
    }

    // Rule: cấm chỉnh GET 200 - Get All / Get Detail
    if (
      response.status_code === 200 &&
      (response.name === "Get All Success" ||
        response.name === "Get Detail Success")
    ) {
      throw new Error("This response is not editable.");
    }

    const { rows } = await dbPoolfull.query(
      `UPDATE endpoint_responses_ful
       SET name = COALESCE($1, name),
           status_code = COALESCE($2, status_code),
           response_body = COALESCE($3, response_body),
           delay_ms = COALESCE($4, delay_ms),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [name, status_code, response_body, delay_ms, id]
    );

    return rows[0] || null;
  }
}

// Hàm check nhanh xem response thuộc endpoint stateful hay không
async function checkIsStatefull(dbPool, dbPoolfull, responseId) {
  // Thử tìm ở stateless trước
  const { rows: r1 } = await dbPool.query(
    `SELECT e.is_statefull
     FROM endpoints e
     INNER JOIN endpoint_responses r ON e.id = r.endpoint_id
     WHERE r.id = $1`,
    [responseId]
  );
  if (r1.length > 0) return r1[0].is_statefull || false;

  // Nếu không có → thử tìm ở stateful
  const { rows: r2 } = await dbPoolfull.query(
    `SELECT e.is_statefull
     FROM endpoints e
INNER JOIN endpoints_ful ef ON e.id = ef.origin_id
     INNER JOIN endpoint_responses_ful rf ON ef.id = rf.endpoint_id
     WHERE rf.id = $1`,
    [responseId]
  );
  return r2[0]?.is_statefull || false;
}
// Cập nhật danh sách priority cho nhiều response
// Tham số: items = [{ id, endpoint_id, priority }, ...]
// Lưu ý: không tự reorder liên tục; giá trị priority sẽ được set theo input
// Trả về: mảng các bản ghi { id, endpoint_id, priority } đã cập nhật thành công
async function updatePriorities(dbPool, items) {
  // items: [{ id, endpoint_id, priority }]
  if (!Array.isArray(items) || items.length === 0) return [];
  // We can optionally validate same endpoint_id; we proceed to update as provided
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
  // Ensure the target response exists and get its endpoint_id
  const current = await getById(dbPool, id);
  if (!current) return [];
  const endpointId = current.endpoint_id;

  // Unset others, then set this one
  await dbPool.query(
    "UPDATE endpoint_responses SET is_default = FALSE WHERE endpoint_id = $1",
    [endpointId]
  );
  await dbPool.query(
    "UPDATE endpoint_responses SET is_default = TRUE, updated_at = NOW() WHERE id = $1",
    [id]
  );

  // Return summary list for that endpoint
  const { rows } = await dbPool.query(
    "SELECT id, endpoint_id, is_default FROM endpoint_responses WHERE endpoint_id = $1 ORDER BY id ASC",
    [endpointId]
  );
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
