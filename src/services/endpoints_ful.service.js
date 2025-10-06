// src/services/endpoints_ful.service.js
const { statefulPool, statelessPool } = require("../config/db");
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
  //chuyển sang stateful

  // endpoints_ful.service.js
  async convertToStateful(statelessPool, statefulPool, endpointId) {
    const clientStateless = await statelessPool.connect();
    const clientStateful = await statefulPool.connect();

    try {
      await clientStateless.query("BEGIN");
      await clientStateful.query("BEGIN");

      // 1) Lấy endpoint stateless
      const {
        rows: [endpoint],
      } = await clientStateless.query(`SELECT * FROM endpoints WHERE id = $1`, [
        endpointId,
      ]);
      if (!endpoint) throw new Error("Stateless endpoint not found");

      // 2) Tìm stateful cũ theo origin_id
      const { rows: existing } = await clientStateful.query(
        `SELECT id, is_active, path, method FROM endpoints_ful WHERE origin_id = $1 LIMIT 1`,
        [endpoint.id]
      );

      if (existing.length > 0) {
        // --- Reactivate nhánh đã từng stateful ---
        const statefulId = existing[0].id;

        // 2.1) Bật lại bản ghi stateful
        await clientStateful.query(
          `UPDATE endpoints_ful SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
          [statefulId]
        );

        // 2.2) Cập nhật cờ bên stateless
        await clientStateless.query(
          `UPDATE endpoints SET is_stateful = TRUE, is_active = FALSE, updated_at = NOW() WHERE id = $1`,
          [endpointId]
        );

        await clientStateful.query("COMMIT");
        await clientStateless.query("COMMIT");

        // 2.3) Đảm bảo dữ liệu mặc định sau khi re-activate (ngoài transaction)
        await this.ensureDefaultsForReactivate(
          statefulPool,
          statefulId,
          existing[0].path ?? endpoint.path,
          existing[0].method ?? endpoint.method
        );

        // 2.4)  sinh lại responses mặc định nếu thiếu
        // await this.generateDefaultResponses(statefulPool, { id: statefulId, method: endpoint.method });

        return {
          stateful_id: statefulId,
        };
      }

      //Convert lần đầu
      await clientStateless.query(
        `UPDATE endpoints SET is_stateful = TRUE, is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [endpointId]
      );

      const {
        rows: [statefulEndpoint],
      } = await clientStateful.query(
        `INSERT INTO endpoints_ful (folder_id, name, method, path, is_active, origin_id)
       VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING *`,
        [
          endpoint.folder_id,
          endpoint.name,
          endpoint.method,
          endpoint.path,
          endpoint.id,
        ]
      );

      await clientStateful.query("COMMIT");
      await clientStateless.query("COMMIT");

      // tạo responses mặc định + endpoint_data_ful nếu thiếu
      const responsesResult = await this.generateDefaultResponses(
        statefulPool,
        statefulEndpoint
      );

      // KHÔNG dùng lại clientStateful ở đây; dùng pool mới 
      const { rows: existingData } = await statefulPool.query(
        `SELECT 1 FROM endpoint_data_ful WHERE path = $1 LIMIT 1`,
        [statefulEndpoint.path]
      );
      if (existingData.length === 0) {
        await statefulPool.query(
          `INSERT INTO endpoint_data_ful (path, schema, data_default, data_current)
         VALUES ($1, $2, $3, $4)`,
          [
            statefulEndpoint.path,
            JSON.stringify({ id: { type: "number", required: false } }),
            JSON.stringify([{ id: 1 }]),
            JSON.stringify([]),
          ]
        );
      }

      return {
        stateless: endpoint,
        stateful: statefulEndpoint,
        responses: responsesResult,
      };
    } catch (err) {
      // rollback cả hai phía nếu có lỗi
      try {
        await clientStateless.query("ROLLBACK");
      } catch {}
      try {
        await clientStateful.query("ROLLBACK");
      } catch {}
      // trả lỗi ra ngoài để controller trả response phù hợp
      throw err;
    } finally {
      clientStateless.release();
      clientStateful.release();
    }
  },

  async revertToStateless(statelessPool, statefulPool, endpointId) {
    const clientStateless = await statelessPool.connect();
    const clientStateful = await statefulPool.connect();
    try {
      await clientStateless.query("BEGIN");
      await clientStateful.query("BEGIN");

      // 1) Tắt stateful nếu tồn tại
      const { rows: existing } = await clientStateful.query(
        `SELECT id FROM endpoints_ful WHERE origin_id = $1 LIMIT 1`,
        [endpointId]
      );
      if (existing.length > 0) {
        await clientStateful.query(
          `UPDATE endpoints_ful SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
          [existing[0].id]
        );
      }

      // 2) Bật lại stateless + hạ cờ is_stateful
      await clientStateless.query(
        `UPDATE endpoints SET is_stateful = FALSE, is_active = TRUE, updated_at = NOW() WHERE id = $1`,
        [endpointId]
      );

      await clientStateless.query("COMMIT");
      await clientStateful.query("COMMIT");

      return {
        statefulExists: existing.length > 0,
        statefulActive: false,
        statelessIsStateful: false,
        statelessActive: true,
      };
    } catch (err) {
      await clientStateless.query("ROLLBACK");
      await clientStateful.query("ROLLBACK");
      throw err;
    } finally {
      clientStateless.release();
      clientStateful.release();
    }
  },
  // Đảm bảo có endpoint_data_ful và endpoint_responses_ful sau khi re-activate
  async ensureDefaultsForReactivate(statefulPool, statefulId, path, method) {
    // endpoint_data_ful theo path
    const { rows: dataRows } = await statefulPool.query(
      `SELECT 1 FROM endpoint_data_ful WHERE path = $1 LIMIT 1`,
      [path]
    );
    if (dataRows.length === 0) {
      await statefulPool.query(
        `INSERT INTO endpoint_data_ful (path, schema, data_default, data_current)
       VALUES ($1, $2, $3, $4)`,
        [
          path,
          JSON.stringify({ id: { type: "number", required: false } }),
          JSON.stringify([{ id: 1 }]),
          JSON.stringify([]),
        ]
      );
    }

    // endpoint_responses_ful theo endpoint_id (stateful)
    const { rows: respRows } = await statefulPool.query(
      `SELECT 1 FROM endpoint_responses_ful WHERE endpoint_id = $1 LIMIT 1`,
      [statefulId]
    );
    if (respRows.length === 0) {
      await this.generateDefaultResponses(statefulPool, {
        id: statefulId,
        method,
      });
    }
  },

  /**
   * Sinh default responses dựa trên method của endpoint
   * @param {object} endpoint - endpoint vừa insert vào stateful
   */
  async generateDefaultResponses(statefulPool, endpoint) {
    const { id: endpointId, method } = endpoint;
    const responseMap = {
      GET: this.ResponsesForGET,
      POST: this.ResponsesForPOST,
      PUT: this.ResponsesForPUT,
      DELETE: this.ResponsesForDELETE,
    };
    const responseFunc = responseMap[method.toUpperCase()];
    if (responseFunc) {
      return responseFunc.call(this, statefulPool, endpointId);
    }
    return { message: `No default responses defined for method: ${method}` };
  },

  async insertResponses(dbStateful, endpointId, responses) {
    const client = await dbStateful.connect();
    try {
      for (const res of responses) {
        await client.query(
          `INSERT INTO endpoint_responses_ful (endpoint_id, name, status_code, response_body, delay_ms) VALUES ($1, $2, $3, $4, $5)`,
          [
            endpointId,
            res.name,
            res.status_code,
            JSON.stringify(res.response_body ?? {}),
            res.delay_ms || 0,
          ]
        );
      }
      return { message: "Responses inserted", count: responses.length };
    } catch (err) {
      throw err;
    } finally {
      client.release();
    }
  },
  // Các hàm tạo response mặc định cho từng Method 
  async ResponsesForGET(dbStateful, endpointId) {
    const responses = [
      { name: "Get All Success", status_code: 200, response_body: [{}] },
      { name: "Get Detail Success", status_code: 200, response_body: {} },
      {
        name: "Get Detail Not Found",
        status_code: 404,
        response_body: { message: "Resource not found." },
      },
    ];
    return this.insertResponses(dbStateful, endpointId, responses);
  },
  async ResponsesForPOST(dbStateful, endpointId) {
    const responses = [
      {
        name: "Create Success",
        status_code: 201,
        response_body: { message: "Created successfully!" },
      },
      {
        name: "Schema Invalid",
        status_code: 400,
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
    return this.insertResponses(dbStateful, endpointId, responses);
  },
  async ResponsesForPUT(dbStateful, endpointId) {
    const responses = [
      {
        name: "Update Success",
        status_code: 200,
        response_body: { message: "Updated successfully!" },
      },
      {
        name: "Not Found",
        status_code: 404,
        response_body: { message: "Update failed: resource not found." },
      },
    ];
    return this.insertResponses(dbStateful, endpointId, responses);
  },
  async ResponsesForDELETE(dbStateful, endpointId) {
    const responses = [
      {
        name: "Delete Success",
        status_code: 200,
        response_body: { message: "Resource deleted successfully." },
      },
      {
        name: "Delete All Success",
        status_code: 200,
        response_body: { message: "Resource deleted all successfully." },
      },
      {
        name: "Not Found",
        status_code: 404,
        response_body: { message: "Delete failed: resource not found." },
      }
    ];
    return this.insertResponses(dbStateful, endpointId, responses);
  },

  async updateEndpointResponse(
    dbStateful,
    responseId,
    { response_body, delay }
  ) {
    const client = await dbStateful.connect();
    try {
      const {
        rows: [response],
      } = await client.query(
        `SELECT * FROM endpoint_responses_ful WHERE id = $1`,
        [responseId]
      );
      if (!response) throw new Error("Response not found");
      if (
        response.status_code === 200 &&
        (response.name === "Get All Success" ||
          response.name === "Get Detail Success")
      ) {
        throw new Error("This response is not editable.");
      }
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
      if (updates.length === 0) return response;
      values.push(responseId);
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE endpoint_responses_ful SET ${updates.join(
          ", "
        )}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      return updated;
    } finally {
      client.release();
    }
  },

  async updateEndpointData(statefulPool, path, body) {
    if (!statefulPool) {
      throw new Error("Database pool (statefulPool) is undefined");
    }

    if (!body) {
      throw new Error("Body không hợp lệ hoặc thiếu");
    }

    const { schema, data_default } = body;

    // 1. Lấy record hiện tại
    const { rows } = await statefulPool.query(
      `SELECT id, schema, data_default FROM endpoint_data_ful WHERE path = $1`,
      [path]
    );
    if (rows.length === 0) {
      throw new Error("Không tìm thấy endpoint_data với path: " + path);
    }
    const current = rows[0];
    let newSchema = current.schema;
    let newDataDefault = current.data_default;

    // 2. Chỉ có schema
    if (schema && !data_default) {
      newSchema = schema;
    }

    // 3. Chỉ có data_default
    if (!schema && data_default) {
      await this.validateDataWithSchema(data_default, current.schema);
      newDataDefault = data_default;
    }

    // 4. Có cả schema và data_default
    if (schema && data_default) {
      await this.validateDataWithSchema(data_default, schema);
      newSchema = schema;
      newDataDefault = data_default;
    }

  // 5. Update DB
    const { rows: updated } = await statefulPool.query(
      `UPDATE endpoint_data_ful
     SET schema = $1,
         data_default = $2,
         updated_at = NOW()
     WHERE path = $3
     RETURNING id, path, schema, data_default, data_current, created_at, updated_at`,
      [JSON.stringify(newSchema), JSON.stringify(newDataDefault), path]
    );

    return updated[0];
  },

  // Hàm validate dữ liệu theo schema
  async validateDataWithSchema(dataDefault, schema) {
    if (!Array.isArray(dataDefault)) {
      throw new Error("data_default phải là array");
    }

    for (const row of dataDefault) {
      for (const [field, rule] of Object.entries(schema)) {
        // check required
        if (rule.required && !(field in row)) {
          throw new Error(`Thiếu field bắt buộc: ${field}`);
        }

        // check type
        if (field in row) {
          const val = row[field];
          switch (rule.type) {
            case "number":
              if (typeof val !== "number")
                throw new Error(`Field ${field} phải là number`);
              break;
            case "string":
              if (typeof val !== "string")
                throw new Error(`Field ${field} phải là string`);
              break;
            case "boolean":
              if (typeof val !== "boolean")
                throw new Error(`Field ${field} phải là boolean`);
              break;
            default:
              throw new Error(`Schema không hỗ trợ type: ${rule.type}`);
          }
        }
      }
    }
  },

};

module.exports = EndpointStatefulService;
