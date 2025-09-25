const db = require("../config/db");

// 📌 Lấy tất cả state của 1 project
async function getAllStatesByProject(projectId) {
  const query = `
    SELECT id, project_id, key, state_type, value, created_at, updated_at
    FROM project_states
    WHERE project_id = $1
    ORDER BY created_at ASC
  `;
  const { rows } = await db.query(query, [projectId]);
  return rows;
}

// 📌 Lấy 1 state theo project_id + key
async function getStateByKey(projectId, key) {
  const query = `
    SELECT id, project_id, key, state_type, value, created_at, updated_at
    FROM project_states
    WHERE project_id = $1 AND key = $2
    LIMIT 1
  `;
  const { rows } = await db.query(query, [projectId, key]);
  return rows[0];
}

// 📌 Lấy state theo id
async function getStateById(id) {
  const query = `
    SELECT id, project_id, key, state_type, value, created_at, updated_at
    FROM project_states
    WHERE id = $1
    LIMIT 1
  `;
  const { rows } = await db.query(query, [id]);
  return rows[0];
}

module.exports = {
  getAllStatesByProject,
  getStateByKey,
  createState,
  updateState,
  deleteState,
  resetStates,
  getStateById, 
};

// 📌 Thêm mới 1 state
async function createState(projectId, key, stateType, value) {
  const query = `
    INSERT INTO project_states (project_id, key, state_type, value, origin_value)
    VALUES ($1, $2, $3, $4::jsonb, $4::jsonb) -- lưu vào cả value và origin_value
    RETURNING *
  `;
  const { rows } = await db.query(query, [
    projectId,
    key,
    stateType,
    JSON.stringify(value)
  ]);
  return rows[0];
}


// 📌 Cập nhật state theo key
async function updateState(projectId, key, value) {
  const query = `
    UPDATE project_states
    SET value = $3::jsonb, updated_at = CURRENT_TIMESTAMP -- chỉ update value
    WHERE project_id = $1 AND key = $2
    RETURNING *
  `;
  const { rows } = await db.query(query, [
    projectId,
    key,
    JSON.stringify(value)
  ]);
  return rows[0];
}


// 📌 Cập nhật state theo id
async function updateStateById(id, value) {
  const query = `
    UPDATE project_states
    SET value = $2::jsonb, updated_at = CURRENT_TIMESTAMP -- không đụng origin_value
    WHERE id = $1
    RETURNING *
  `;
  const { rows } = await db.query(query, [id, JSON.stringify(value)]);
  return rows[0];
}


// 📌 Xóa state theo key
async function deleteState(projectId, key) {
  const query = `
    DELETE FROM project_states
    WHERE project_id = $1 AND key = $2
    RETURNING *
  `;
  const { rows } = await db.query(query, [projectId, key]);
  return rows[0];
}

// 📌 Xóa state theo id
async function deleteStateById(id) {
  const query = `
    DELETE FROM project_states
    WHERE id = $1
    RETURNING *
  `;
  const { rows } = await db.query(query, [id]);
  return rows[0];
}

// 📌 Reset toàn bộ state của project (xóa hết)
async function resetStates(projectId) {
  const query = `
    UPDATE project_states
    SET value = origin_value, updated_at = CURRENT_TIMESTAMP -- copy origin_value → value
    WHERE project_id = $1
    RETURNING *
  `;
  const { rows } = await db.query(query, [projectId]);
  return rows;
}

// 📌 Reset state theo id (copy origin_value → value)
async function resetStateById(id) {
  const query = `
    UPDATE project_states
    SET value = origin_value, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `;
  const { rows } = await db.query(query, [id]);
  return rows[0];
}

// 📌 Reset state theo project_id + key
async function resetStateByKey(projectId, key) {
  const query = `
    UPDATE project_states
    SET value = origin_value, updated_at = CURRENT_TIMESTAMP
    WHERE project_id = $1 AND key = $2
    RETURNING *
  `;
  const { rows } = await db.query(query, [projectId, key]);
  return rows[0];
}



module.exports = {
  getAllStatesByProject,
  getStateByKey,
  getStateById,
  createState,
  updateState,
  updateStateById,
  deleteState,
  deleteStateById,
  resetStates,
  resetStateById,  
  resetStateByKey
};
