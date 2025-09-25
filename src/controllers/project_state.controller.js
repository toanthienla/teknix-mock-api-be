const asyncHandler = require("../middlewares/asyncHandler");
const stateService = require("../services/project_state.service");
const { success, error } = require("../utils/response");

// 📌 Lấy toàn bộ state theo project_id
exports.getAllStates = asyncHandler(async (req, res) => {
  const { project_id } = req.query;
  if (!project_id) {
    return error(res, 400, "Thiếu project_id trong query params");
  }
  const states = await stateService.getAllStatesByProject(project_id);
  return success(res, states);
});

// 📌 Lấy state theo key
exports.getStateByKey = asyncHandler(async (req, res) => {
  const { project_id, key } = req.params;
  const state = await stateService.getStateByKey(project_id, key);
  if (!state) return error(res, 404, "Không tìm thấy state");
  return success(res, state);
});

// 📌 Lấy state theo id
exports.getStateById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const state = await stateService.getStateById(id);
  if (!state) return error(res, 404, "Không tìm thấy state");
  return success(res, state);
});

// 📌 Tạo mới state
exports.createState = asyncHandler(async (req, res) => {
  const { project_id, key, state_type, value } = req.body;
  if (!project_id || !key || !state_type || value === undefined) {
    return error(res, 400, "Thiếu dữ liệu đầu vào");
  }
  const state = await stateService.createState(
    project_id,
    key,
    state_type,
    value
  );
  return success(res, state);
});

// 📌 Cập nhật state theo key
exports.updateState = asyncHandler(async (req, res) => {
  const { project_id, key } = req.params;
  const { value } = req.body;
  const updated = await stateService.updateState(project_id, key, value);
  if (!updated) return error(res, 404, "Không tìm thấy state");
  return success(res, updated);
});

// 📌 Cập nhật state theo id
exports.updateStateById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { value } = req.body;

  if (value === undefined) {
    return error(res, 400, "Thiếu value trong body");
  }

  const updated = await stateService.updateStateById(id, value);
  if (!updated) return error(res, 404, "Không tìm thấy state");
  return success(res, updated);
});

// 📌 Xóa state theo key
exports.deleteState = asyncHandler(async (req, res) => {
  const { project_id, key } = req.params;
  const deleted = await stateService.deleteState(project_id, key);
  if (!deleted) return error(res, 404, "Không tìm thấy state");
  return success(res, deleted);
});

// 📌 Xóa state theo id
exports.deleteStateById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const deleted = await stateService.deleteStateById(id);
  if (!deleted) return error(res, 404, "Không tìm thấy state");

  return success(res, deleted);
});

// 📌 Reset toàn bộ state của project
exports.resetStates = asyncHandler(async (req, res) => {
  const { project_id } = req.params;

  const deleted = await stateService.resetStates(project_id);

  if (deleted.length === 0) {
    return success(res, { success: true, message: "Không có state nào để reset" });
  }

  return success(res, { success: true, message: "All state reset for project" });
});

// 📌 Reset state theo id
exports.resetStateById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const reset = await stateService.resetStateById(id);

  if (!reset) return error(res, 404, "Không tìm thấy state để reset");

  return success(res, { success: true, message: "State reset by id thành công", state: reset });
});

// 📌 Reset state theo key
exports.resetStateByKey = asyncHandler(async (req, res) => {
  const { project_id, key } = req.params;
  const reset = await stateService.resetStateByKey(project_id, key);

  if (!reset) return error(res, 404, "Không tìm thấy state để reset");

  return success(res, { success: true, message: "State reset by key thành công", state: reset });
});
