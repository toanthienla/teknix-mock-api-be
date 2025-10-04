// src/services/endpoints_ful.service.js
const { statefulPool } = require("../config/db");
// Import service của response để lấy dữ liệu liên quan
const ResponseStatefulService = require("./endpoint_responses_ful.service");

const EndpointStatefulService = {
  async findById(id) {
    const query = "SELECT * FROM endpoints_ful WHERE id = $1;";
    const { rows } = await statefulPool.query(query, [id]);
    return rows[0] || null;
  },

  async findByFolderId(folderId) {
    const query =
      "SELECT * FROM endpoints_ful WHERE folder_id = $1 ORDER BY created_at DESC;";
    const { rows } = await statefulPool.query(query, [folderId]);
    return rows;
  },

  /**
   * HÀM MỚI: Lấy đầy đủ thông tin của một stateful endpoint,
   * bao gồm cả các response liên quan.
   * @param {number} id - ID của stateful endpoint
   * @returns {Object | null} - Object chi tiết hoặc null nếu không tìm thấy
   */
  async getFullDetailById(id) {
    // Sử dụng Promise.all để chạy 2 truy vấn song song
    const [endpoint, responses] = await Promise.all([
      this.findById(id),
      ResponseStatefulService.findByEndpointId(id),
    ]);

    // Nếu không tìm thấy endpoint gốc, trả về null
    if (!endpoint) {
      return null;
    }

    // Gộp kết quả lại thành một object hoàn chỉnh
    return {
      ...endpoint,
      is_stateful: true, // Thêm cờ để nhận biết
      responses: responses || [], // Thêm danh sách các response liên quan
    };
  },

  /**
   * HÀM MỚI: Xóa một stateful endpoint và tất cả các dữ liệu liên quan
   * (responses, data) trong một transaction.
   * @param {number} id - ID của stateful endpoint
   * @returns {Object} - Object chứa { success: true } hoặc { success: false, notFound: true }
   */
  async deleteById(id) {
    const client = await statefulPool.connect(); // Lấy client để dùng transaction

    try {
      await client.query("BEGIN");

      // Bước 1: Lấy thông tin endpoint để kiểm tra tồn tại và lấy path
      const { rows: endpointRows } = await client.query(
        "SELECT path FROM endpoints_ful WHERE id = $1",
        [id]
      );
      const endpoint = endpointRows[0];

      if (!endpoint) {
        await client.query("ROLLBACK");
        return { success: false, notFound: true };
      }

      // Bước 2: Xóa tất cả các response liên quan
      await client.query(
        "DELETE FROM endpoint_responses_ful WHERE endpoint_id = $1",
        [id]
      );

      // Bước 3: Xóa dữ liệu stateful liên quan dựa trên path
      if (endpoint.path) {
        await client.query("DELETE FROM endpoint_data_ful WHERE path = $1", [
          endpoint.path,
        ]);
      }

      // Bước 4: Xóa bản ghi endpoint gốc
      await client.query("DELETE FROM endpoints_ful WHERE id = $1", [id]);

      await client.query("COMMIT"); // Hoàn tất transaction
      return { success: true };
    } catch (err) {
      await client.query("ROLLBACK"); // Hoàn tác nếu có lỗi
      console.error(
        `Transaction failed for deleting stateful endpoint ${id}:`,
        err
      );
      throw err; // Ném lỗi để controller bắt và trả về 500
    } finally {
      client.release(); // Luôn trả client về pool
    }
  },

  async findByOriginId(originId) {
    const query = "SELECT id FROM endpoints_ful WHERE origin_id = $1 LIMIT 1;";
    const { rows } = await statefulPool.query(query, [originId]);

    const statefulEndpoint = rows[0];
    if (!statefulEndpoint) {
      return null;
    }

    // Tái sử dụng hàm getFullDetailById để lấy đầy đủ thông tin
    return this.getFullDetailById(statefulEndpoint.id);
  },
};

async function convertToStateful(endpointId) {
  const clientStateless = await dbPool.connect();
  const clientStateful = await dbPoolfull.connect();

  try {
    await clientStateless.query("BEGIN");
    await clientStateful.query("BEGIN");

    // 1. Lấy endpoint từ DB stateless
    const {
      rows: [endpoint],
    } = await clientStateless.query(`SELECT * FROM endpoints WHERE id = $1`, [
      endpointId,
    ]);
    if (!endpoint) {
      throw new Error("Stateless endpoint not found");
    }

    // 2. Kiểm tra xem endpoint này đã được convert sang stateful chưa
    const { rows: existing } = await clientStateful.query(
      `SELECT * FROM endpoints_ful WHERE origin_id = $1`,
      [endpoint.id]
    );
    if (existing.length > 0) {
      throw new Error("This endpoint has already been converted to stateful");
    }

    // 3. Update trạng thái của endpoint bên DB stateless
    await clientStateless.query(
      `UPDATE endpoints
             SET is_stateful = true, is_active = false, updated_at = NOW()
             WHERE id = $1`,
      [endpointId]
    );

    // 4. Insert endpoint mới vào DB stateful
    const {
      rows: [statefulEndpoint],
    } = await clientStateful.query(
      `INSERT INTO endpoints_ful (folder_id, name, method, path, is_active, created_at, updated_at, origin_id)
             VALUES ($1, $2, $3, $4, true, NOW(), NOW(), $5)
             RETURNING *`,
      [
        endpoint.folder_id,
        endpoint.name,
        endpoint.method,
        endpoint.path,
        endpoint.id,
      ]
    );

    // 5. Commit cả 2 DB sau khi insert thành công
    await clientStateless.query("COMMIT");
    await clientStateful.query("COMMIT");

    // 6. Sinh ra response mặc định dựa theo method
    const responsesResult = await generateDefaultResponses(statefulEndpoint);

    // 7. Sinh ra dữ liệu mặc định trong endpoint_data nếu chưa tồn tại
    const { rows: existingData } = await clientStateful.query(
      `SELECT * FROM endpoint_data_ful WHERE path = $1`,
      [statefulEndpoint.path]
    );

    if (existingData.length === 0) {
      await clientStateful.query(
        `INSERT INTO endpoint_data_ful (path, schema, data_default, data_current, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [
          statefulEndpoint.path,
          JSON.stringify({ id: { type: "number", required: false } }),
          JSON.stringify([{ id: 1 }]),
          JSON.stringify([]),
        ]
      );
    }

    // 8. Trả về dữ liệu kết quả sau khi convert
    return {
      stateless: endpoint,
      stateful: statefulEndpoint,
      responses: responsesResult,
    };
  } catch (err) {
    // Rollback cả 2 DB nếu có lỗi
    await clientStateless.query("ROLLBACK");
    await clientStateful.query("ROLLBACK");
    throw new Error(`Failed to convert endpoint: ${err.message}`);
  } finally {
    // Giải phóng kết nối
    clientStateless.release();
    clientStateful.release();
  }
}

/**
 * Sinh default responses dựa trên method của endpoint
 * @param {object} endpoint - endpoint vừa insert vào stateful
 */
async function generateDefaultResponses(endpoint) {
  const { id: endpointId, method } = endpoint;

  switch (method.toUpperCase()) {
    case "GET":
      return ResponsesForGET(endpointId);

    case "POST":
      return ResponsesForPOST(endpointId);

    case "PUT":
      return ResponsesForPUT(endpointId);

    case "DELETE":
      return ResponsesForDELETE(endpointId);

    default:
      return { message: `No default responses defined for method: ${method}` };
  }
}

// ------------------- RESPONSES CHO TỪNG METHOD -------------------

// 1. GET
async function ResponsesForGET(endpointId) {
  const responses = [
    {
      name: "Get All Success",
      status_code: 200,
      response_body: [{}], // danh sách
    },
    {
      name: "Get Detail Success",
      status_code: 200,
      response_body: {}, // object detail
    },
    {
      name: "Get Detail Not Found",
      status_code: 404,
      response_body: { message: "Resource not found." },
    },
  ];

  return insertResponses(endpointId, responses);
}

// 2. POST
async function ResponsesForPOST(endpointId) {
  const responses = [
    {
      name: "Create Success",
      status_code: 201,
      response_body: { message: "Created successfully!" },
    },
    {
      name: "Schema Invalid",
      status_code: 403,
      response_body: {
        message: "Creation failed: data does not follow schema.",
      },
    },
    {
      name: "ID Conflict",
      status_code: 409,
      response_body: { message: "Creation failed: id conflicts in array." },
    },
  ];

  return insertResponses(endpointId, responses);
}

// 3. PUT
async function ResponsesForPUT(endpointId) {
  const responses = [
    {
      name: "Update Success",
      status_code: 200,
      response_body: { message: "Updated successfully!" },
    },
    {
      name: "Schema Invalid",
      status_code: 403,
      response_body: { message: "Update failed: data does not follow schema." },
    },
    {
      name: "ID Conflict",
      status_code: 409,
      response_body: {
        message: "Update failed: id in body conflicts in array.",
      },
    },
    {
      name: "Not Found",
      status_code: 404,
      response_body: { message: "Update failed: resource not found." },
    },
  ];

  return insertResponses(endpointId, responses);
}

// 4. DELETE
async function ResponsesForDELETE(endpointId) {
  const responses = [
    {
      name: "Delete All Success",
      status_code: 200,
      response_body: { message: "All resources deleted successfully." },
    },
    {
      name: "Delete By ID Success",
      status_code: 200,
      response_body: { message: "Resource deleted successfully." },
    },
  ];

  return insertResponses(endpointId, responses);
}

// ------------------- HÀM CHUNG CHÈN RESPONSES -------------------
/**
 * Insert nhiều response mặc định cho một endpoint trong DB stateful
 * @param {number} endpointId - ID của endpoint_ful
 * @param {Array} responses - Mảng các response object
 *    {
 *       name: string,
 *       status_code: number,
 *       response_body: object | array,
 *       delay_ms?: number
 *    }
 */
async function insertResponses(endpointId, responses) {
  const client = await dbPoolfull.connect();
  try {
    for (const res of responses) {
      await client.query(
        `INSERT INTO endpoint_responses_ful 
          (endpoint_id, name, status_code, response_body, delay_ms, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [
          endpointId,
          res.name,
          res.status_code,
          JSON.stringify(res.response_body ?? {}), // stringify JSONB
          res.delay_ms || 0,
        ]
      );
    }
    return { message: "Responses inserted", count: responses.length };
  } catch (err) {
    console.error("Error inserting responses:", err);
    throw err;
  } finally {
    client.release();
  }
}

// ------------------- CẬP NHẬT RESPONSE -------------------
/**
 * Cập nhật response_body hoặc delay của response stateful
 * @param {number} responseId - ID của response trong endpoint_responses_ful
 * @param {object} param1 - { response_body, delay }
 */
async function updateEndpointResponse(responseId, { response_body, delay }) {
  const client = await dbPoolfull.connect();
  try {
    // 1. Lấy response theo id
    const {
      rows: [response],
    } = await client.query(
      `SELECT * FROM endpoint_responses_ful WHERE id = $1`,
      [responseId]
    );
    if (!response) {
      throw new Error("Response not found");
    }

    // 2. Rule: GET 200 (all, detail) thì không cho chỉnh
    if (
      response.status_code === 200 &&
      (response.name === "Get All Success" ||
        response.name === "Get Detail Success")
    ) {
      throw new Error("This response is not editable.");
    }

    // 3. Chuẩn bị dữ liệu update
    const updates = [];
    const values = [];
    let idx = 1;

    if (response_body !== undefined) {
      updates.push(`response_body = $${idx++}`);
      values.push(JSON.stringify(response_body));
    }

    if (delay !== undefined) {
      updates.push(`delay_ms = $${idx++}`);
      values.push(delay);
    }

    if (updates.length === 0) {
      throw new Error("Nothing to update");
    }

    values.push(responseId);

    // 4. Update DB
    const {
      rows: [updated],
    } = await client.query(
      `UPDATE endpoint_responses_ful
             SET ${updates.join(", ")}, updated_at = NOW()
             WHERE id = $${idx}
             RETURNING *`,
      values
    );

    return updated;
  } finally {
    client.release();
  }
}

module.exports = {
  EndpointStatefulService,
  convertToStateful,
  generateDefaultResponses,
  insertResponses,
  ResponsesForGET,
  ResponsesForPOST,
  ResponsesForPUT,
  ResponsesForDELETE,
  updateEndpointResponse,
};
