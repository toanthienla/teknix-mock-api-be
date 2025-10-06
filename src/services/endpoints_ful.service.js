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

      // === 1.5) Kiểm tra xem path có route parameter hay không ===
      if (endpoint.path.includes(":")) {
        throw new Error(
          "This endpoint contains route parameters and cannot be converted to stateful."
        );
      }

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
    const { id: endpointId, method, path } = endpoint; // lấy path luôn
    const responseMap = {
      GET: this.ResponsesForGET,
      POST: this.ResponsesForPOST,
      PUT: this.ResponsesForPUT,
      DELETE: this.ResponsesForDELETE,
    };
    const responseFunc = responseMap[method.toUpperCase()];
    if (responseFunc) {
      return responseFunc.call(this, statefulPool, endpointId, path);
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
  // --- Các hàm tạo response mặc định cho từng Method ---
  async ResponsesForGET(dbStateful, endpointId, endpointPath) {
    // Cắt path và uppercase chữ cái đầu
    const pathSegment =
      endpointPath.split("/").filter(Boolean).pop() || "Resource";
    const capitalizedPath =
      pathSegment.charAt(0).toUpperCase() + pathSegment.slice(1);

    const responses = [
      { name: "Get All Success", status_code: 200, response_body: [{}] },
      { name: "Get Detail Success", status_code: 200, response_body: {} },
      {
        name: "Get Detail Not Found",
        status_code: 404,
        response_body: {
          message: `${capitalizedPath} with id {{params.id}} not found.`,
        }, // template với path đúng
      },
    ];
    return this.insertResponses(dbStateful, endpointId, responses);
  },
  async ResponsesForPOST(dbStateful, endpointId, endpointPath) {
    // Cắt path và uppercase chữ cái đầu
    const pathSegment =
      endpointPath.split("/").filter(Boolean).pop() || "Resource";
    const capitalizedPath =
      pathSegment.charAt(0).toUpperCase() + pathSegment.slice(1);

    const responses = [
      {
        name: "Create Success",
        status_code: 201,
        response_body: {
          message: `New ${capitalizedPath} item added successfully.`,
        }, // dynamic
      },
      {
        name: "Schema Invalid",
        status_code: 403,
        response_body: {
          message: `Invalid data: request does not match ${capitalizedPath} object schema.`,
        },
      },
      {
        name: "ID Conflict",
        status_code: 409,
        response_body: {
          message: `${capitalizedPath} {{params.id}} conflict: {{params.id}} already exists.`,
        },
      },
    ];
    return this.insertResponses(dbStateful, endpointId, responses);
  },
  async ResponsesForPUT(dbStateful, endpointId, endpointPath) {
    // Cắt path và uppercase chữ cái đầu
    const pathSegment =
      endpointPath.split("/").filter(Boolean).pop() || "Resource";
    const capitalizedPath =
      pathSegment.charAt(0).toUpperCase() + pathSegment.slice(1);

    const responses = [
      {
        name: "Update Success",
        status_code: 200,
        response_body: {
          message: `${capitalizedPath} with id {{params.id}} updated successfully.`,
        },
      },
      {
        name: "Schema Invalid",
        status_code: 403,
        response_body: {
          message: `Invalid data: request does not match ${capitalizedPath} schema.`,
        },
      },
      {
        name: "ID Conflict",
        status_code: 409,
        response_body: {
          message: `Update id {{params.id}} conflict: ${capitalizedPath} id {{params.id}} in request body already exists.`,
        },
      },
      {
        name: "Not Found",
        status_code: 404,
        response_body: {
          message: `${capitalizedPath} with id {{params.id}} not found.`,
        },
      },
    ];

    return this.insertResponses(dbStateful, endpointId, responses);
  },
  async ResponsesForDELETE(dbStateful, endpointId, endpointPath) {
    // Cắt path và uppercase chữ cái đầu
    const pathSegment =
      endpointPath.split("/").filter(Boolean).pop() || "Resource";
    const capitalizedPath =
      pathSegment.charAt(0).toUpperCase() + pathSegment.slice(1);

    const responses = [
      {
        name: "Delete All Success",
        status_code: 200,
        response_body: {
          message: `Delete all data with ${capitalizedPath} successfully.`,
        },
      },
      {
        name: "Delete Success",
        status_code: 200,
        response_body: {
          message: `${capitalizedPath} with id {{params.id}} deleted successfully.`,
        },
      },
      {
        name: "Not Found",
        status_code: 404,
        response_body: {
          message: `${capitalizedPath} with id {{params.id}} to delete not found.`,
        },
      },
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

  /**
   * Validate + cập nhật endpoint_data_ful theo các rule:
   * - Nếu payload có cả schema + data_default:
   *    -> validate(data_default, schema), auto-id nếu id không required và thiếu
   *    -> set schema, data_default, data_current = data_default
   * - Nếu chỉ có schema:
   *    -> cho phép cập nhật thẳng schema
   * - Nếu chỉ có data_default:
   *    -> validate với schema hiện tại (bắt buộc phải có schema)
   *    -> auto-id nếu id không required và thiếu
   *    -> set data_default và data_current = data_default
   */
  async updateEndpointData(statefulPool, path, body) {
    if (!statefulPool)
      throw new Error("Database pool (statefulPool) is undefined");
    if (!body) throw new Error("Body không hợp lệ hoặc thiếu");

    const { schema, data_default } = body;

    // 1) Lấy record hiện tại
    const { rows } = await statefulPool.query(
      `SELECT id, schema, data_default, data_current
     FROM endpoint_data_ful
     WHERE path = $1`,
      [path]
    );
    if (rows.length === 0) {
      throw new Error("Không tìm thấy endpoint_data với path: " + path);
    }
    const current = rows[0];

    // ---- Helpers (giữ nguyên) ------------------------------------------------
    const typeOf = (v) =>
      Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    const orderedSchemaKeys = (sch) => Object.keys(sch || {});
    const hasSameKeyOrderAsSchema = (obj, sch) => {
      const sKeys = orderedSchemaKeys(sch);
      const dKeys = Object.keys(obj || {});
      if (sKeys.length !== dKeys.length) return false;
      for (let i = 0; i < sKeys.length; i++)
        if (sKeys[i] !== dKeys[i]) return false;
      return true;
    };
    const validateObjectWithSchema = (obj, sch) => {
      const sKeys = orderedSchemaKeys(sch);
      if (!hasSameKeyOrderAsSchema(obj, sch)) {
        return {
          ok: false,
          reason: `Thứ tự/trường không khớp schema. Schema: [${sKeys.join(
            ", "
          )}], Data: [${Object.keys(obj).join(", ")}]`,
        };
      }
      for (const key of sKeys) {
        const rule = sch[key];
        const value = obj[key];
        const isMissing = value === undefined;
        if (rule.required && isMissing)
          return { ok: false, reason: `Thiếu trường bắt buộc: "${key}"` };
        if (!isMissing) {
          const jsType = typeOf(value);
          const ok =
            (rule.type === "number" && jsType === "number") ||
            (rule.type === "string" && jsType === "string") ||
            (rule.type === "boolean" && jsType === "boolean") ||
            (rule.type === "object" && jsType === "object") ||
            (rule.type === "array" && jsType === "array");
          if (!ok)
            return {
              ok: false,
              reason: `Sai kiểu "${key}". Mong đợi: ${rule.type}, thực tế: ${jsType}`,
            };
        }
      }
      return { ok: true };
    };
    const autoAssignIdsIfAllowed = (dataArr, sch) => {
      if (!Array.isArray(dataArr))
        throw new Error("data_default phải là một mảng object");
      const idOptional = !!(
        sch?.id &&
        sch.id.type === "number" &&
        sch.id.required === false
      );
      let nextId = 1;
      const seen = new Set();
      for (const o of dataArr)
        if (o && typeof o.id === "number") seen.add(o.id);
      if (seen.size > 0) nextId = Math.max(...seen) + 1;
      if (idOptional) {
        for (let i = 0; i < dataArr.length; i++) {
          if (dataArr[i].id === undefined)
            dataArr[i].id =
              seen.size === 0
                ? i === 0
                  ? 1
                  : dataArr[i - 1].id + 1
                : nextId++;
        }
      }
      return dataArr;
    };
    const ensureUniqueIdsIfPresent = (dataArr) => {
      const set = new Set();
      for (const o of dataArr) {
        if (o.id !== undefined) {
          if (set.has(o.id))
            return {
              ok: false,
              reason: `Trùng id trong data_default: ${o.id}`,
            };
          set.add(o.id);
        }
      }
      return { ok: true };
    };
    const validateArrayWithSchema = (dataArr, sch) => {
      if (!Array.isArray(dataArr))
        return { ok: false, reason: "data_default phải là mảng các object" };
      for (let i = 0; i < dataArr.length; i++) {
        const r = validateObjectWithSchema(dataArr[i], sch);
        if (!r.ok)
          return {
            ok: false,
            reason: `Phần tử thứ ${i} không hợp lệ: ${r.reason}`,
          };
      }
      const u = ensureUniqueIdsIfPresent(dataArr);
      if (!u.ok) return u;
      return { ok: true };
    };

    // Schema & data hiện tại
    const currentSchema = current.schema || null;
    const currentDefault = Array.isArray(current.data_default)
      ? current.data_default
      : current.data_default || null;
    const currentCurrent = Array.isArray(current.data_current)
      ? current.data_current
      : current.data_current || null;

    // ---- Logic chính (đã sửa nhánh "chỉ schema") -----------------------------
    let newSchema = currentSchema;
    let newDataDefault = currentDefault;
    let newDataCurrent = currentCurrent;

    // 1) Cả schema + data_default
    if (schema && data_default) {
      if (typeof schema !== "object" || Array.isArray(schema))
        throw new Error("schema phải là object (map field -> rule)");
      if (!Array.isArray(data_default))
        throw new Error("data_default phải là mảng object");

      const dataWithIds = autoAssignIdsIfAllowed(
        JSON.parse(JSON.stringify(data_default)),
        schema
      );
      const v = validateArrayWithSchema(dataWithIds, schema);
      if (!v.ok) throw new Error(`Dữ liệu không khớp schema: ${v.reason}`);

      newSchema = schema;
      newDataDefault = dataWithIds;
      newDataCurrent = dataWithIds; // data_current = data_default
    }

    // 2) Chỉ schema  <<<<  SỬA Ở ĐÂY: KHÔNG VALIDATE GÌ CẢ
    if (schema && !data_default) {
      if (typeof schema !== "object" || Array.isArray(schema)) {
        throw new Error("schema phải là object (map field -> rule)");
      }
      // Không kiểm tra currentDefault/currentCurrent — cập nhật thẳng
      newSchema = schema;
    }

    // 3) Chỉ data_default
    if (!schema && data_default) {
      if (!currentSchema)
        throw new Error(
          "Không thể cập nhật data_default khi chưa có schema hiện tại"
        );
      if (!Array.isArray(data_default))
        throw new Error("data_default phải là mảng object");

      const dataWithIds = autoAssignIdsIfAllowed(
        JSON.parse(JSON.stringify(data_default)),
        currentSchema
      );
      const v = validateArrayWithSchema(dataWithIds, currentSchema);
      if (!v.ok)
        throw new Error(`data_default không khớp schema hiện tại: ${v.reason}`);

      newDataDefault = dataWithIds;
      newDataCurrent = dataWithIds; // data_current = data_default
    }

    if (!schema && !data_default) {
      throw new Error(
        "Payload phải có ít nhất một trong hai: schema hoặc data_default"
      );
    }

    // 4) Update DB
    const { rows: updated } = await statefulPool.query(
      `UPDATE endpoint_data_ful
     SET schema = $1,
         data_default = $2,
         data_current = $3,
         updated_at = NOW()
     WHERE path = $4
     RETURNING id, path, schema, data_default, data_current, created_at, updated_at`,
      [
        newSchema ? JSON.stringify(newSchema) : null,
        newDataDefault ? JSON.stringify(newDataDefault) : null,
        newDataCurrent ? JSON.stringify(newDataCurrent) : null,
        path,
      ]
    );

    return updated[0];
  },
};
module.exports = EndpointStatefulService;
