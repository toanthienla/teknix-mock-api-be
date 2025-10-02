const db = require("../config/db");
const endpointResponseService = require("./endpoint_response.service"); // import service response

// Get all endpoints (filter by project_id OR folder_id)
async function getEndpoints({ project_id, folder_id }) {
  // Chọn tất cả các cột từ bảng endpoints
  let query = `
    SELECT e.id, e.folder_id, e.name, e.method, e.path, e.is_active, e.is_stateful, e.created_at, e.updated_at 
    FROM endpoints e
  `;
  const params = [];
  let paramIndex = 1;

  // Nếu có project_id, chúng ta JOIN với bảng folders
  if (project_id) {
    query += ` JOIN folders f ON e.folder_id = f.id WHERE f.project_id = $${paramIndex++}`;
    params.push(project_id);

    // Nếu không có project_id nhưng có folder_id, chúng ta lọc trực tiếp
  } else if (folder_id) {
    query += ` WHERE e.folder_id = $${paramIndex++}`;
    params.push(folder_id);
  }

  query += " ORDER BY e.created_at DESC";

  const { rows } = await db.query(query, params);
  return rows;
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
async function createEndpoint({
  folder_id,
  name,
  method,
  path,
  is_active,
  is_stateful,
}) {
  const errors = [];

  // Check duplicate name (ignore case)
  const { rows: nameRows } = await db.query(
    "SELECT id FROM endpoints WHERE folder_id=$1 AND LOWER(name)=LOWER($2)",
    [folder_id, name]
  );
  if (nameRows.length > 0) {
    errors.push({
      field: "name",
      message: "Name already exists in this folder",
    });
  }

  // Check path + method constraints (case-sensitive path)
  const { rows: samePathRows } = await db.query(
    "SELECT method FROM endpoints WHERE folder_id=$1 AND path=$2",
    [folder_id, path]
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
  const final_is_active = is_active === undefined ? true : is_active;
  const final_is_stateful = is_stateful === undefined ? false : is_stateful;

  const { rows } = await db.query(
    "INSERT INTO endpoints(folder_id, name, method, path, is_active, is_stateful) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
    [folder_id, name, method, path, final_is_active, final_is_stateful]
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
async function updateEndpoint(
  endpointId,
  { name, method, path, is_active, is_stateful }
) {
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
  let finalIsActive = is_active ?? current.is_active;
  let finalIsStateful = is_stateful ?? current.is_stateful;

  // Chỉ áp dụng quy tắc khi `is_stateful` được cung cấp trong request body
  // QUY TẮC 1 (Ưu tiên cao nhất): Nếu trạng thái cuối cùng là stateful,
  // thì active BẮT BUỘC phải là false.
  if (finalIsStateful === true) {
    finalIsActive = false;
  }
  // QUY TẮC 2: Nếu stateful vừa được TẮT đi (từ true -> false),
  // thì active sẽ mặc định là true, trừ khi người dùng chỉ định khác.
  else if (is_stateful === false && current.is_stateful === true) {
    finalIsActive = is_active ?? true;
  }
  // Nếu `newIsStateful` là false, `finalIsActive` có thể là true/false tùy ý.

  // Nếu dữ liệu không thay đổi => trả về object hiện tại
  if (
    newName === current.name &&
    newMethod === current.method &&
    newPath === current.path &&
    finalIsActive === current.is_active &&
    finalIsStateful === current.is_stateful
  ) {
    return { success: true, data: current };
  }
  // Check duplicate name (ignore case)
  if (newName.toLowerCase() !== current.name.toLowerCase()) {
    const { rows: nameRows } = await db.query(
      "SELECT id FROM endpoints WHERE id<>$1 AND folder_id=$2 AND LOWER(name)=LOWER($3)",
      [endpointId, current.folder_id, newName]
    );
    if (nameRows.length > 0) {
      errors.push({
        field: "name",
        message: "Name already exists in this folder",
      });
    }
  }

  // Check path + method constraints (case-sensitive path)
  if (
    newPath !== current.path ||
    newMethod.toUpperCase() !== current.method.toUpperCase()
  ) {
    const { rows: samePathRows } = await db.query(
      "SELECT method FROM endpoints WHERE id<>$1 AND folder_id=$2 AND path=$3",
      [endpointId, current.folder_id, newPath]
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
    "UPDATE endpoints SET name=$1, method=$2, path=$3, is_active=$4, is_stateful=$5, updated_at=NOW() WHERE id=$6 RETURNING *",
    [newName, newMethod, newPath, finalIsActive, finalIsStateful, endpointId]
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
