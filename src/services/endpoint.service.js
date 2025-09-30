const db = require("../config/db");
const endpointResponseService = require("./endpoint_response.service"); // import service response

// Get all endpoints (optionally filter by project_id)
async function getEndpoints(project_id) {
  let query = "SELECT * FROM endpoints";
  const params = [];

  if (project_id) {
    query += " WHERE project_id=$1";
    params.push(project_id);
  }

  query += " ORDER BY created_at DESC";
  const { rows } = await db.query(query, params);
  return rows; // array object trần
}

// Get endpoint by id
async function getEndpointById(endpointId) {
  const { rows } = await db.query(
    "SELECT * FROM endpoints WHERE id=$1 LIMIT 1",
    [endpointId]
  );
  return rows[0] || null;
}

// Create endpoint
async function createEndpoint({ project_id, name, method, path, is_active }) {
  const errors = [];

  // Check duplicate name (ignore case)
  const { rows: nameRows } = await db.query(
    "SELECT id FROM endpoints WHERE project_id=$1 AND LOWER(name)=LOWER($2)",
    [project_id, name]
  );
  if (nameRows.length > 0) {
    errors.push({
      field: "name",
      message: "Name already exists in this project",
    });
  }

  // Check path + method constraints (case-sensitive path)
  const { rows: samePathRows } = await db.query(
    "SELECT method FROM endpoints WHERE project_id=$1 AND path=$2",
    [project_id, path]
  );

  const usedMethods = samePathRows.map((r) => r.method.toUpperCase());
  const methodUpper = method.toUpperCase();

  if (usedMethods.includes(methodUpper)) {
    errors.push({
      field: "method",
      message: "Method already exists for this path",
    });
  }
  if (!usedMethods.includes(methodUpper) && usedMethods.length >= 4) {
    errors.push({ field: "path", message: "Path already has all 4 methods" });
  }

  if (errors.length > 0) return { success: false, errors };

  // Xử lý giá trị mặc định cho is_active
  // Nếu is_active không được gửi lên (undefined), mặc định là true. Ngược lại, dùng giá trị được gửi.
  const final_is_active = is_active === undefined ? true : is_active;

  const { rows } = await db.query(
    "INSERT INTO endpoints(project_id, name, method, path, is_active) VALUES($1,$2,$3,$4,$5) RETURNING *",
    [project_id, name, method, path, final_is_active]
  );

  const endpoint = rows[0];

  // --- Auto-create default endpoint_response ---
  await endpointResponseService.create({
    endpoint_id: endpoint.id,
    name: "Success",
    status_code: 200,
    response_body: { success: true },
    condition: {},
    is_default: true,
    delay_ms: 0,
  });

  return { success: true, data: endpoint };
}

// Update endpoint
async function updateEndpoint(endpointId, { name, method, path, is_active }) {
  const errors = [];

  // Lấy endpoint hiện tại
  const { rows: currentRows } = await db.query(
    "SELECT * FROM endpoints WHERE id=$1",
    [endpointId]
  );
  const current = currentRows[0];
  if (!current) return null;

  const newName = name ?? current.name;
  const newMethod = method ?? current.method;
  const newPath = path ?? current.path;
  const newIsActive = is_active ?? current.is_active;

  // Nếu dữ liệu không thay đổi => trả về object hiện tại
  if (
    newName === current.name &&
    newMethod === current.method &&
    newPath === current.path &&
    newIsActive === current.is_active
  ) {
    return { success: true, data: current };
  }
  // Check duplicate name (ignore case)
  if (newName.toLowerCase() !== current.name.toLowerCase()) {
    const { rows: nameRows } = await db.query(
      "SELECT id FROM endpoints WHERE id<>$1 AND project_id=$2 AND LOWER(name)=LOWER($3)",
      [endpointId, current.project_id, newName]
    );
    if (nameRows.length > 0) {
      errors.push({
        field: "name",
        message: "Name already exists in this project",
      });
    }
  }

  // Check path + method constraints (case-sensitive path)
  if (
    newPath !== current.path ||
    newMethod.toUpperCase() !== current.method.toUpperCase()
  ) {
    const { rows: samePathRows } = await db.query(
      "SELECT method FROM endpoints WHERE id<>$1 AND project_id=$2 AND path=$3",
      [endpointId, current.project_id, newPath]
    );

    const usedMethods = samePathRows.map((r) => r.method.toUpperCase());
    const newMethodUpper = newMethod.toUpperCase();

    if (usedMethods.includes(newMethodUpper)) {
      errors.push({
        field: "method",
        message: "Method already exists for this path",
      });
    }
    if (!usedMethods.includes(newMethodUpper) && usedMethods.length >= 4) {
      errors.push({ field: "path", message: "Path already has all 4 methods" });
    }
  }

  if (errors.length > 0) return { success: false, errors };

  const { rows: updatedRows } = await db.query(
    "UPDATE endpoints SET name=$1, method=$2, path=$3, is_active=$4, updated_at=NOW() WHERE id=$5 RETURNING *",
    [newName, newMethod, newPath, newIsActive, endpointId]
  );

  return { success: true, data: updatedRows[0] };
}

// Delete endpoint
async function deleteEndpoint(endpointId) {
  const { rows: currentRows } = await db.query(
    "SELECT * FROM endpoints WHERE id=$1",
    [endpointId]
  );
  const current = currentRows[0];
  if (!current) return null;

  await db.query("DELETE FROM endpoints WHERE id=$1", [endpointId]);
  return { success: true, data: current };
}

module.exports = {
  getEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
};
