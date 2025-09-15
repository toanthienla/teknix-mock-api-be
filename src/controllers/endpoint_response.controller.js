const svc = require('../services/endpoint_response.service');
const { success, error } = require('../utils/response');

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

async function create(req, res) {
  try {
    const { endpoint_id, name, status_code, response_body, is_default } = req.body;

    if (!endpoint_id || !name || typeof status_code === 'undefined') {
      return error(res, 400, 'Cần có endpoint_id, name, status_code');
    }

    const eid = parseInt(endpoint_id, 10);
    if (Number.isNaN(eid)) return error(res, 400, 'endpoint_id phải là số nguyên');

    const row = await svc.create({
      endpoint_id: eid,
      name,
      status_code,
      response_body: response_body ?? null,
      is_default: Boolean(is_default)
    });
    return success(res, row);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function update(req, res) {
  try {
    const { id } = req.params;
    const rid = parseInt(id, 10);
    if (Number.isNaN(rid)) return error(res, 400, 'id phải là số nguyên');

    const { name, status_code, response_body, is_default } = req.body;
    const row = await svc.update(rid, {
      name,
      status_code,
      response_body,
      is_default: typeof is_default === 'undefined' ? undefined : Boolean(is_default)
    });
    return success(res, row);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

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

module.exports = {
  listByEndpointQuery,
  getById,
  create,
  update,
  remove
};
