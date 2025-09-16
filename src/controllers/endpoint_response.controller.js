// Controller cho Endpoint Responses
// Nhiệm vụ: nhận request, validate đầu vào, gọi service và trả response thống nhất
// Bao gồm: list theo endpoint_id (query), lấy chi tiết, tạo mới, cập nhật,
// cập nhật thứ tự (priority), đặt mặc định và xóa
const svc = require('../services/endpoint_response.service');
const { success, error } = require('../utils/response');

// [GET] /endpoint_responses?endpoint_id=...
// Trả về danh sách response của một endpoint cụ thể
// - Validate endpoint_id phải là số nguyên
async function listByEndpointQuery(req, res) {
  try {
    const { endpoint_id } = req.query;
    if (!endpoint_id) return error(res, 400, 'Cần query endpoint_id');

    const eid = parseInt(endpoint_id, 10);
    if (Number.isNaN(eid)) return error(res, 400, 'endpoint_id phải là số nguyên');

    const rows = await svc.getByEndpointId(eid);
    return success(res, rows);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [GET] /endpoint_responses/:id
// Lấy chi tiết một response theo id
// - Validate id là số nguyên
// - 404 nếu không tìm thấy
async function getById(req, res) {
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, 'id phải là số nguyên');

    const row = await svc.getById(rid);
    if (!row) return error(res, 404, 'Response không tồn tại');
    return success(res, row);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [POST] /endpoint_responses
// Tạo mới response cho endpoint
// Body yêu cầu: { endpoint_id, name, status_code, response_body, condition, is_default, delay_ms }
// Business:
//  - Nếu là response đầu tiên của endpoint → service sẽ tự set is_default = true
//  - Nếu gửi is_default = true → service sẽ unset is_default các response khác cùng endpoint
async function create(req, res) {
  try {
    const { endpoint_id, name, status_code, response_body, condition, is_default, delay_ms } = req.body;

    if (!endpoint_id || !name || typeof status_code === 'undefined') {
      return error(res, 400, 'Cần có endpoint_id, name, status_code');
    }

    const eid = parseInt(endpoint_id, 10);
    if (Number.isNaN(eid)) return error(res, 400, 'endpoint_id phải là số nguyên');

    const row = await svc.create({
      endpoint_id: eid,
      name,
      status_code,
      response_body: response_body ?? {},
      condition: condition ?? {},
      is_default: Boolean(is_default),
      delay_ms: typeof delay_ms === 'number' ? delay_ms : 0
    });
    return success(res, row);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [PUT] /endpoint_responses/:id
// Cập nhật thông tin response theo id
// Body cho phép: { name, status_code, response_body, condition, is_default, delay_ms }
// Business:
//  - Nếu is_default = true → service sẽ unset is_default của response khác cùng endpoint
async function update(req, res) {
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, 'id phải là số nguyên');

    const { name, status_code, response_body, condition, is_default, delay_ms } = req.body;
    const row = await svc.update(rid, {
      name,
      status_code,
      response_body,
      condition,
      is_default: typeof is_default === 'undefined' ? undefined : Boolean(is_default),
      delay_ms: typeof delay_ms === 'undefined' ? undefined : parseInt(delay_ms, 10)
    });
    return success(res, row);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [PUT] /endpoint_responses/priority
// Cập nhật priority theo danh sách item
// Body: Array<{ id, endpoint_id, priority }>
// Lưu ý: route phải đặt trước /:id để không bị bắt nhầm
async function updatePriorities(req, res) {
  try {
    const items = req.body;
    if (!Array.isArray(items)) return error(res, 400, 'Payload phải là mảng các item {id, endpoint_id, priority}');
    // Basic validation
    for (const it of items) {
      if (!it || typeof it.id === 'undefined' || typeof it.endpoint_id === 'undefined' || typeof it.priority === 'undefined') {
        return error(res, 400, 'Mỗi item cần có id, endpoint_id, priority');
      }
    }
    const result = await svc.updatePriorities(items.map((it) => ({
      id: parseInt(it.id, 10),
      endpoint_id: parseInt(it.endpoint_id, 10),
      priority: parseInt(it.priority, 10)
    })));
    return success(res, result);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [DELETE] /endpoint_responses/:id
// Xóa một response theo id
// - Validate id là số nguyên
async function remove(req, res) {
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, 'id phải là số nguyên');

    await svc.remove(rid);
    return success(res, {});
  } catch (err) {
    return error(res, 400, err.message);
  }
}

// [PUT] /endpoint_responses/:id/set_default
// Đặt một response làm mặc định cho endpoint của nó
// - Service sẽ unset is_default tất cả response khác cùng endpoint
async function setDefault(req, res) {
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, 'id phải là số nguyên');

    const rows = await svc.setDefault(rid);
    return success(res, rows);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

module.exports = {
  listByEndpointQuery,
  getById,
  create,
  update,
  setDefault,
  updatePriorities,
  remove
};
