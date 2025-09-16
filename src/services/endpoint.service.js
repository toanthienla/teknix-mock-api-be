const db = require('../config/db');

// Get all endpoints (optionally filter by project_id)
async function getEndpoints(project_id) {
  let query = 'SELECT * FROM endpoints';
  const params = [];

  if (project_id) {
    query += ' WHERE project_id=$1';
    params.push(project_id);
  }

  query += ' ORDER BY created_at DESC';
  const { rows } = await db.query(query, params);
  return rows; // trả về array object trần
}

// Get endpoint by id
async function getEndpointById(endpointId) {
  const { rows } = await db.query(
    'SELECT * FROM endpoints WHERE id=$1 LIMIT 1',
    [endpointId]
  );
  return rows[0] || null;
}

// Create endpoint
async function createEndpoint({ project_id, name, method, path }) {
  const errors = [];

  // Check duplicate name
  const { rows: nameRows } = await db.query(
    `SELECT id FROM endpoints WHERE project_id=$1 AND LOWER(name)=LOWER($2)`,
    [project_id, name]
  );
  if (nameRows.length > 0) {
    errors.push({ field: "name", message: "Name already exists in this project" });
  }

  // Check duplicate method + path
  const { rows: methodPathRows } = await db.query(
    `SELECT id FROM endpoints 
     WHERE project_id=$1 AND LOWER(method)=LOWER($2) AND LOWER(path)=LOWER($3)`,
    [project_id, method, path]
  );
  if (methodPathRows.length > 0) {
    errors.push({ field: "method", message: "Method already exists for this path" });
    errors.push({ field: "path", message: "Path already exists for this method" });
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const { rows } = await db.query(
    'INSERT INTO endpoints(project_id, name, method, path) VALUES($1,$2,$3,$4) RETURNING *',
    [project_id, name, method, path]
  );

  return { success: true, data: rows[0] }; // trả về object trần trong data
}

// Update endpoint
async function updateEndpoint(endpointId, { name, method, path }) {
  const errors = [];

  // Lấy endpoint hiện tại
  const { rows: currentRows } = await db.query(
    'SELECT * FROM endpoints WHERE id=$1',
    [endpointId]
  );
  const current = currentRows[0];
  if (!current) return null;

  const newName = name ?? current.name;
  const newMethod = method ?? current.method;
  const newPath = path ?? current.path;

  // Nếu dữ liệu y hệt => trả về object hiện tại
  if (newName === current.name && newMethod === current.method && newPath === current.path) {
    return { success: true, data: current };
  }

  // Check duplicate name
  const { rows: nameRows } = await db.query(
    `SELECT id FROM endpoints 
     WHERE id<>$1 AND project_id=$2 AND LOWER(name)=LOWER($3)`,
    [endpointId, current.project_id, newName]
  );
  if (nameRows.length > 0) {
    errors.push({ field: "name", message: "Name already exists in this project" });
  }

  // Check duplicate method + path
  const { rows: methodPathRows } = await db.query(
    `SELECT id FROM endpoints 
     WHERE id<>$1 AND project_id=$2 AND LOWER(method)=LOWER($3) AND LOWER(path)=LOWER($4)`,
    [endpointId, current.project_id, newMethod, newPath]
  );
  if (methodPathRows.length > 0) {
    errors.push({ field: "method", message: "Method already exists for this path" });
    errors.push({ field: "path", message: "Path already exists for this method" });
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const { rows } = await db.query(
    `UPDATE endpoints 
     SET name=$1, method=$2, path=$3, updated_at=NOW() 
     WHERE id=$4 
     RETURNING *`,
    [newName, newMethod, newPath, endpointId]
  );

  return { success: true, data: rows[0] }; // object trần
}

// Delete endpoint
async function deleteEndpoint(endpointId) {
  const { rows: currentRows } = await db.query(
    'SELECT * FROM endpoints WHERE id=$1',
    [endpointId]
  );
  const current = currentRows[0];
  if (!current) return null;

  await db.query('DELETE FROM endpoints WHERE id=$1', [endpointId]);
  return { success: true, data: current }; // trả về object trần trước khi xóa
}

module.exports = {
  getEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint
};
