module.exports = {
  /**
   * Bộ xử lý chính cho endpoint stateful
   * @param {Request} req
   * @param {Response} res
   */
  async handle(req, res) {
    const { method, path, body, db, endpoint } = req;

    try {
      const { rows } = await db.stateful.query(
        "SELECT * FROM endpoint_data_ful WHERE path = $1 LIMIT 1",
        [endpoint.path]
      );

      if (rows.length === 0) {
        return res
          .status(404)
          .json({ error: "Không tìm thấy dữ liệu stateful" });
      }

      const dataRow = rows[0];
      const currentData = dataRow.data_current || [];

      switch (method.toUpperCase()) {
        case "GET": {
          console.log("📍 req.path:", req.path);
          console.log("📍 req.params:", req.params);

          // 1️⃣ Kiểm tra endpoint có stateful không
          const { rows: endpointRows } = await db.stateful.query(
            `SELECT id, path, method, is_stateful, is_active
                        FROM endpoints_ful 
                        WHERE path = $1 AND UPPER(method) = $2`,
            [endpoint.path, method]
          );

          const endpointInfo = endpointRows[0];
          if (!endpointInfo) {
            return res
              .status(404)
              .json({ message: "Endpoint not found in stateful DB." });
          }

          if (!endpointInfo.is_stateful || !endpointInfo.is_active) {
            return res
              .status(400)
              .json({
                message: "This endpoint is not enabled for stateful mode.",
              });
          }

          // 2️⃣ Lấy dữ liệu hiện tại từ endpoint_data_ful
          const { rows: dataRows } = await db.stateful.query(
            `SELECT data_current FROM endpoint_data_ful WHERE path = $1`,
            [endpoint.path]
          );

          let currentData = [];
          if (dataRows.length > 0) {
            try {
              const raw = dataRows[0].data_current;
              currentData = typeof raw === "string" ? JSON.parse(raw) : raw;
            } catch (err) {
              console.error("❌ JSON parse error:", err.message);
              currentData = [];
            }
          }

          // 3️⃣ Lấy response template mặc định (status 200)
          const { rows: responseRows } = await db.stateful.query(
            `SELECT response_body
                        FROM endpoint_responses_ful
                        WHERE endpoint_id = $1
                        AND status_code = 200
                        LIMIT 1`,
            [endpointInfo.id]
          );
          const baseResponseBody = responseRows[0]?.response_body || null;

          // 4️⃣ Nếu không có id param → trả tất cả dữ liệu
          if (!req.params.id) {
            return res
              .status(200)
              .json(Array.isArray(currentData) ? currentData : [currentData]);
          }

          // 5️⃣ Nếu có id → validate id
          const idParam = Number(req.params.id);
          if (isNaN(idParam)) {
            const { rows: badReqRows } = await db.stateful.query(
              `SELECT response_body
                            FROM endpoint_responses_ful
                            WHERE endpoint_id = $1
                            AND status_code = 400
                            LIMIT 1`,
              [endpointInfo.id]
            );

            const badReqBody = badReqRows[0]?.response_body || {
              message: "Invalid id parameter.",
            };
            return res.status(400).json(badReqBody);
          }

          // 6️⃣ Tìm item theo id
          const foundItem = currentData.find((item) => item.id === idParam);
          if (!foundItem) {
            // Lấy response_body 404 từ endpoint_responses_ful
            const { rows: notFoundRows } = await db.stateful.query(
              `SELECT response_body
                            FROM endpoint_responses_ful
                            WHERE endpoint_id = $1
                            AND status_code = 404
                            LIMIT 1`,
              [endpointInfo.id]
            );

            const notFoundBody = notFoundRows[0]?.response_body || {
              message: "Item not found.",
            };
            // Nếu response_body trong DB là JSON string, parse ra object
            let body;
            if (typeof notFoundBody === "string") {
              try {
                body = JSON.parse(notFoundBody);
              } catch (err) {
                console.error(
                  "❌ JSON parse error for 404 response_body:",
                  err.message
                );
                body = { message: "Item not found." };
              }
            } else {
              body = notFoundBody;
            }

            return res.status(404).json(body);
          }

          // 7️⃣ Trả về item đúng
          return res.status(200).json(foundItem);
        }

        // ======================================================
        // CASE: POST
        // ======================================================
        case "POST": {
          const payload = body;

          // 1️⃣ Kiểm tra endpoint có stateful và active không
          const { rows: endpointRows } = await db.stateful.query(
            `SELECT id, path, method, is_stateful, is_active
                        FROM endpoints_ful 
                        WHERE path = $1 AND UPPER(method) = $2`,
            [endpoint.path, method]
          );

          const endpointInfo = endpointRows[0];
          if (!endpointInfo) {
            // Lỗi 404: không lấy response_body, trả lỗi server chuẩn
            return res
              .status(404)
              .json({ message: "Endpoint not found in stateful DB." });
          }
          if (!endpointInfo.is_stateful || !endpointInfo.is_active) {
            // Lỗi 400: không lấy response_body, trả lỗi server chuẩn
            return res
              .status(400)
              .json({
                message: "This endpoint is not enabled for stateful mode.",
              });
          }

          // 2️⃣ Lấy schema & data_current
          const { rows: dataRows } = await db.stateful.query(
            `SELECT schema, data_current FROM endpoint_data_ful WHERE path = $1 LIMIT 1`,
            [endpoint.path]
          );
          if (dataRows.length === 0) {
            return res
              .status(404)
              .json({ message: "No stateful data found for this endpoint." });
          }
          const dataRow = dataRows[0];
          const schema = dataRow.schema || {};
          let currentData = Array.isArray(dataRow.data_current)
            ? dataRow.data_current
            : [];

          // 3️⃣ Auto tăng id nếu cần
          if (
            schema.id &&
            schema.id.required === false &&
            payload.id === undefined
          ) {
            const maxId =
              currentData.length > 0
                ? Math.max(...currentData.map((d) => d.id || 0))
                : 0;
            payload.id = maxId + 1;
          }

          // 4️⃣ Kiểm tra schema
          const isValid = Object.entries(schema).every(([key, rule]) => {
            const value = payload[key];
            if (rule.required && value === undefined) return false;
            if (value !== undefined) {
              if (rule.type === "number" && typeof value !== "number")
                return false;
              if (rule.type === "string" && typeof value !== "string")
                return false;
              if (rule.type === "boolean" && typeof value !== "boolean")
                return false;
            }
            return true;
          });

          if (!isValid) {
            // Lấy response_body từ DB status_code = 403
            const { rows: respRows } = await db.stateful.query(
              `SELECT response_body 
                            FROM endpoint_responses_ful 
                            WHERE endpoint_id = $1 AND status_code = 403 LIMIT 1`,
              [endpointInfo.id]
            );

            let responseBody = respRows[0]?.response_body ?? null; // không fallback
            if (typeof responseBody === "string") {
              try {
                responseBody = JSON.parse(responseBody);
              } catch (_) {}
            }

            return res.status(403).json(responseBody);
          }

          // 5️⃣ Kiểm tra trùng ID
          if (payload.id !== undefined) {
            const conflict = currentData.some((item) => item.id === payload.id);
            if (conflict) {
              // Lấy response_body từ DB status_code = 409
              const { rows: respRows } = await db.stateful.query(
                `SELECT response_body 
                                FROM endpoint_responses_ful 
                                WHERE endpoint_id = $1 AND status_code = 409 LIMIT 1`,
                [endpointInfo.id]
              );

              let responseBody = respRows[0]?.response_body ?? null; // không fallback
              if (typeof responseBody === "string") {
                try {
                  responseBody = JSON.parse(responseBody);
                } catch (_) {}
              }

              return res.status(409).json(responseBody);
            }
          }

          // 6️⃣ Thêm dữ liệu mới
          const newData = [...currentData, payload];
          await db.stateful.query(
            `UPDATE endpoint_data_ful 
                        SET data_current = $1, updated_at = NOW()
                        WHERE path = $2`,
            [JSON.stringify(newData), endpoint.path]
          );

          // 7️⃣ Thành công: lấy response_body từ DB status_code = 200
          const { rows: successRows } = await db.stateful.query(
            `SELECT response_body 
                        FROM endpoint_responses_ful 
                        WHERE endpoint_id = $1 AND status_code = 201 LIMIT 1`,
            [endpointInfo.id]
          );

          let successBody = successRows[0]?.response_body ?? null; // dùng null thay vì fallback
          if (typeof successBody === "string") {
            try {
              successBody = JSON.parse(successBody);
            } catch (_) {
              // nếu không parse được thì để nguyên chuỗi
            }
          }

          return res.status(201).json(successBody);
        }

        case "PUT": {
          const payload = body;

          // 1️⃣ Kiểm tra endpoint có stateful và active không
          const { rows: endpointRows } = await db.stateful.query(
            `SELECT id, path, method, is_stateful, is_active
         FROM endpoints_ful 
         WHERE path = $1 AND UPPER(method) = $2`,
            [endpoint.path, method]
          );

          const endpointInfo = endpointRows[0];
          if (!endpointInfo) {
            return res
              .status(404)
              .json({ message: "Endpoint not found in stateful DB." });
          }
          if (!endpointInfo.is_stateful || !endpointInfo.is_active) {
            return res
              .status(400)
              .json({
                message: "This endpoint is not enabled for stateful mode.",
              });
          }

          // 2️⃣ Lấy schema & data_current từ endpoint_data_ful
          const { rows: dataRows } = await db.stateful.query(
            `SELECT schema, data_current FROM endpoint_data_ful WHERE path = $1 LIMIT 1`,
            [endpoint.path]
          );
          if (dataRows.length === 0) {
            return res
              .status(404)
              .json({ message: "No stateful data found for this endpoint." });
          }
          const dataRow = dataRows[0];
          const schema = dataRow.schema || {};
          let currentData = Array.isArray(dataRow.data_current)
            ? dataRow.data_current
            : [];

          // 3️⃣ Lấy ID từ URL
          const pathParts = path.split("/").filter(Boolean);
          const idFromUrl = Number(pathParts[pathParts.length - 1]);
          if (isNaN(idFromUrl)) {
            return res.status(400).json({ message: "Invalid ID in URL." });
          }

          // 4️⃣ Tìm item trong data_current
          const existingIndex = currentData.findIndex(
            (item) => item.id === idFromUrl
          );
          if (existingIndex === -1) {
            // Lấy response_body từ DB status_code = 404
            const { rows: notFoundRows } = await db.stateful.query(
              `SELECT response_body 
             FROM endpoint_responses_ful 
             WHERE endpoint_id = $1 AND status_code = 404 LIMIT 1`,
              [endpointInfo.id]
            );
            let responseBody = notFoundRows[0]?.response_body ?? null;
            if (typeof responseBody === "string") {
              try {
                responseBody = JSON.parse(responseBody);
              } catch (_) {}
            }
            return res.status(404).json(responseBody);
          }

          // 5️⃣ Kiểm tra payload hợp lệ theo schema
          const isValid = Object.entries(schema).every(([key, rule]) => {
            const value = payload[key];
            if (rule.required && value === undefined) return false;
            if (value !== undefined) {
              if (rule.type === "number" && typeof value !== "number")
                return false;
              if (rule.type === "string" && typeof value !== "string")
                return false;
              if (rule.type === "boolean" && typeof value !== "boolean")
                return false;
            }
            return true;
          });

          if (!isValid) {
            // Lấy response_body từ DB status_code = 403
            const { rows: respRows } = await db.stateful.query(
              `SELECT response_body 
             FROM endpoint_responses_ful 
             WHERE endpoint_id = $1 AND status_code = 403 LIMIT 1`,
              [endpointInfo.id]
            );
            let responseBody = respRows[0]?.response_body ?? null;
            if (typeof responseBody === "string") {
              try {
                responseBody = JSON.parse(responseBody);
              } catch (_) {}
            }
            return res.status(403).json(responseBody);
          }

          // 6️⃣ Kiểm tra xung đột ID (nếu payload.id khác với idFromUrl)
          if (payload.id !== undefined && payload.id !== idFromUrl) {
            const conflict = currentData.some((item) => item.id === payload.id);
            if (conflict) {
              // Lấy response_body từ DB status_code = 409
              const { rows: respRows } = await db.stateful.query(
                `SELECT response_body 
                 FROM endpoint_responses_ful 
                 WHERE endpoint_id = $1 AND status_code = 409 LIMIT 1`,
                [endpointInfo.id]
              );
              let responseBody = respRows[0]?.response_body ?? null;
              if (typeof responseBody === "string") {
                try {
                  responseBody = JSON.parse(responseBody);
                } catch (_) {}
              }
              return res.status(409).json(responseBody);
            }
          }

          // 7️⃣ Cập nhật item trong data_current
          const updatedItem = { ...currentData[existingIndex], ...payload };
          currentData[existingIndex] = updatedItem;

          await db.stateful.query(
            `UPDATE endpoint_data_ful 
         SET data_current = $1, updated_at = NOW()
         WHERE path = $2`,
            [JSON.stringify(currentData), endpoint.path]
          );

          // 8️⃣ Trả về response 200 thành công
          const { rows: successRows } = await db.stateful.query(
            `SELECT response_body 
         FROM endpoint_responses_ful 
         WHERE endpoint_id = $1 AND status_code = 200 LIMIT 1`,
            [endpointInfo.id]
          );
          let responseBody = successRows[0]?.response_body ?? null;
          if (typeof responseBody === "string") {
            try {
              responseBody = JSON.parse(responseBody);
            } catch (_) {}
          }

          return res.status(200).json(responseBody);
        }

        case "DELETE": {
          // 1️⃣ Kiểm tra endpoint có stateful và active không
          const { rows: endpointRows } = await db.stateful.query(
            `SELECT id, path, method, is_stateful, is_active
         FROM endpoints_ful 
         WHERE path = $1 AND UPPER(method) = $2`,
            [endpoint.path, method]
          );

          const endpointInfo = endpointRows[0];
          if (!endpointInfo) {
            return res
              .status(404)
              .json({ message: "Endpoint not found in stateful DB." });
          }
          if (!endpointInfo.is_stateful || !endpointInfo.is_active) {
            return res
              .status(400)
              .json({
                message: "This endpoint is not enabled for stateful mode.",
              });
          }

          // 2️⃣ Lấy dữ liệu hiện tại từ endpoint_data_ful
          const { rows: dataRows } = await db.stateful.query(
            `SELECT data_current FROM endpoint_data_ful WHERE path = $1 LIMIT 1`,
            [endpoint.path]
          );
          if (dataRows.length === 0) {
            return res
              .status(404)
              .json({ message: "No stateful data found for this endpoint." });
          }

          let currentData = Array.isArray(dataRows[0].data_current)
            ? dataRows[0].data_current
            : [];

          // 3️⃣ Lấy ID từ URL nếu có
          const pathParts = path.split("/").filter(Boolean);
          const idFromUrl =
            pathParts.length > 1
              ? Number(pathParts[pathParts.length - 1])
              : null;

          // 🔹 Trường hợp xóa tất cả (DELETE /users)
          if (idFromUrl === null || isNaN(idFromUrl)) {
            await db.stateful.query(
              `UPDATE endpoint_data_ful
             SET data_current = $1, updated_at = NOW()
             WHERE path = $2`,
              [JSON.stringify([]), endpoint.path]
            );

            const { rows: successRows } = await db.stateful.query(
              `SELECT response_body 
             FROM endpoint_responses_ful
             WHERE endpoint_id = $1 AND status_code = 200 LIMIT 1`,
              [endpointInfo.id]
            );
            let responseBody = successRows[0]?.response_body ?? null;
            if (typeof responseBody === "string") {
              try {
                responseBody = JSON.parse(responseBody);
              } catch (_) {}
            }
            return res.status(200).json(responseBody);
          }

          // 🔹 Trường hợp xóa theo id (DELETE /users/:id)
          if (isNaN(idFromUrl)) {
            // Lấy response_body status_code = 400
            const { rows: badReqRows } = await db.stateful.query(
              `SELECT response_body 
             FROM endpoint_responses_ful
             WHERE endpoint_id = $1 AND status_code = 400 LIMIT 1`,
              [endpointInfo.id]
            );
            let responseBody = badReqRows[0]?.response_body ?? null;
            if (typeof responseBody === "string") {
              try {
                responseBody = JSON.parse(responseBody);
              } catch (_) {}
            }
            return res.status(400).json(responseBody);
          }

          const itemIndex = currentData.findIndex(
            (item) => item.id === idFromUrl
          );

          if (itemIndex === -1) {
            // Lấy response_body status_code = 404
            const { rows: notFoundRows } = await db.stateful.query(
              `SELECT response_body 
             FROM endpoint_responses_ful
             WHERE endpoint_id = $1 AND status_code = 404 LIMIT 1`,
              [endpointInfo.id]
            );
            let responseBody = notFoundRows[0]?.response_body ?? null;
            if (typeof responseBody === "string") {
              try {
                responseBody = JSON.parse(responseBody);
              } catch (_) {}
            }
            return res.status(404).json(responseBody);
          }

          // 4️⃣ Xóa item khỏi data_current
          currentData.splice(itemIndex, 1);

          await db.stateful.query(
            `UPDATE endpoint_data_ful
         SET data_current = $1, updated_at = NOW()
         WHERE path = $2`,
            [JSON.stringify(currentData), endpoint.path]
          );

          // Lấy response_body status_code = 200
          const { rows: successRows } = await db.stateful.query(
            `SELECT response_body 
         FROM endpoint_responses_ful
         WHERE endpoint_id = $1 AND status_code = 200 LIMIT 1`,
            [endpointInfo.id]
          );
          let responseBody = successRows[0]?.response_body ?? null;
          if (typeof responseBody === "string") {
            try {
              responseBody = JSON.parse(responseBody);
            } catch (_) {}
          }
          return res.status(200).json(responseBody);
        }

        default:
          return res
            .status(405)
            .json({ error: `Phương thức ${method} chưa hỗ trợ.` });
      }
    } catch (err) {
      console.error("❌ Lỗi trong statefulHandler:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: err.message });
    }
  },
};
