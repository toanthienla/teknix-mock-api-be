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
                return res.status(404).json({ error: "Không tìm thấy dữ liệu stateful" });
            }

            const dataRow = rows[0];
            const currentData = dataRow.data_current || [];

            switch (method.toUpperCase()) {
                case "GET": {
                    console.log("📍 req.path:", req.path);
                    console.log("📍 req.params:", req.params);

                    // 1️⃣ Kiểm tra endpoint có stateful không
                    const { rows: endpointRows } = await db.stateful.query(
                        `SELECT id, path, method, is_active AS is_stateful
                        FROM endpoints_ful 
                        WHERE path = $1 AND UPPER(method) = $2`,
                        [endpoint.path, method]
                    );

                    const endpointInfo = endpointRows[0];
                    if (!endpointInfo) {
                        return res.status(404).json({ message: "Endpoint not found in stateful DB." });
                    }

                    if (!endpointInfo.is_stateful) {
                        return res.status(400).json({ message: "This endpoint is not enabled for stateful mode." });
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
                        return res.status(200).json(
                            Array.isArray(currentData) ? currentData : [currentData]
                        );
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

                        const badReqBody = badReqRows[0]?.response_body || { message: "Invalid id parameter." };
                        return res.status(400).json(badReqBody);
                    }

                    // 6️⃣ Tìm item theo id
                    const foundItem = currentData.find(item => item.id === idParam);
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

                        let notFoundBody = notFoundRows[0].response_body;

                        // --- Render template {{params.id}} ---
                        const renderTemplate = (value, ctx) => {
                            if (typeof value === "string") {
                                return value.replace(/\{\{params\.id\}\}/g, ctx.id ?? "");
                            }
                            if (typeof value === "object" && value !== null) {
                                const out = Array.isArray(value) ? [] : {};
                                for (const [k, v] of Object.entries(value)) {
                                    out[k] = renderTemplate(v, ctx);
                                }
                                return out;
                            }
                            return value;
                        };

                        const ctx = { id: idParam };
                        const body = renderTemplate(notFoundBody, ctx);

                        return res.status(404).json(body);
                    }

                    // 7️⃣ Trả về item đúng
                    return res.status(200).json(foundItem);
                }


                // ======================================================
                // CASE: POST
                // ======================================================
                case "POST": {
                    const payload = req.body;
                    const path = endpoint.path;
                    const methodUpper = method.toUpperCase();

                    // 1️⃣ Lấy thông tin endpoint trong DB stateful
                    const { rows: endpointRows } = await db.stateful.query(
                        `SELECT id, path, method, is_active AS is_stateful
     FROM endpoints_ful 
     WHERE path = $1 AND UPPER(method) = $2`,
                        [path, methodUpper]
                    );

                    const endpointInfo = endpointRows[0];
                    if (!endpointInfo) {
                        return res.status(404).json({ message: "Endpoint not found in stateful DB." });
                    }
                    if (!endpointInfo.is_stateful) {
                        return res.status(400).json({ message: "This endpoint is not enabled for stateful mode." });
                    }

                    // 2️⃣ Lấy schema + dữ liệu hiện tại
                    const { rows: dataRows } = await db.stateful.query(
                        `SELECT schema, data_current FROM endpoint_data_ful WHERE path = $1 LIMIT 1`,
                        [path]
                    );
                    if (dataRows.length === 0) {
                        return res.status(404).json({ message: "No stateful data found for this endpoint." });
                    }

                    const dataRow = dataRows[0];
                    const schema = dataRow.schema || {};
                    let currentData = Array.isArray(dataRow.data_current) ? dataRow.data_current : [];

                    // 3️⃣ Tự sinh id nếu schema có id và không required
                    if (schema.id && schema.id.required === false && payload.id === undefined) {
                        const maxId = currentData.length > 0 ? Math.max(...currentData.map(d => d.id || 0)) : 0;
                        payload.id = maxId + 1;
                    }

                    // 4️⃣ Hàm render template cho {{params.id}}
                    const renderTemplate = (value, ctx) => {
                        if (typeof value === "string") {
                            return value.replace(/\{\{params\.id\}\}/g, ctx.id ?? "");
                        }
                        if (typeof value === "object" && value !== null) {
                            const out = Array.isArray(value) ? [] : {};
                            for (const [k, v] of Object.entries(value)) {
                                out[k] = renderTemplate(v, ctx);
                            }
                            return out;
                        }
                        return value;
                    };

                    const ctx = { id: payload.id };

                    // 5️⃣ Validate dữ liệu theo schema
                    const schemaKeys = Object.keys(schema);
                    const payloadKeys = Object.keys(payload);

                    let isValid = true;

                    // ❌ Check: Có key nào trong payload không nằm trong schema không?
                    const extraKeys = payloadKeys.filter(k => !schemaKeys.includes(k));
                    if (extraKeys.length > 0) {
                        isValid = false;
                    }

                    // ❌ Check: Có thiếu field required nào không?
                    if (isValid) {
                        for (const [key, rule] of Object.entries(schema)) {
                            const value = payload[key];
                            if (rule.required && value === undefined) {
                                isValid = false;
                                break;
                            }
                            if (value !== undefined) {
                                if (rule.type === "number" && typeof value !== "number") {
                                    isValid = false;
                                    break;
                                }
                                if (rule.type === "string" && typeof value !== "string") {
                                    isValid = false;
                                    break;
                                }
                                if (rule.type === "boolean" && typeof value !== "boolean") {
                                    isValid = false;
                                    break;
                                }
                            }
                        }
                    }

                    // ❌ Nếu dữ liệu không hợp lệ, trả về 403 theo cấu hình response_body
                    if (!isValid) {
                        const { rows: respRows } = await db.stateful.query(
                            `SELECT response_body FROM endpoint_responses_ful 
       WHERE endpoint_id = $1 AND status_code = 403 LIMIT 1`,
                            [endpointInfo.id]
                        );
                        const responseBody = respRows[0]?.response_body ?? { message: "Invalid request body structure." };
                        const renderedBody = renderTemplate(responseBody, ctx);
                        return res.status(403).json(renderedBody);
                    }

                    // 6️⃣ Check conflict id (nếu trùng)
                    if (payload.id !== undefined) {
                        const conflict = currentData.some(item => item.id === payload.id);
                        if (conflict) {
                            const { rows: respRows } = await db.stateful.query(
                                `SELECT response_body FROM endpoint_responses_ful 
         WHERE endpoint_id = $1 AND status_code = 409 LIMIT 1`,
                                [endpointInfo.id]
                            );
                            const responseBody = respRows[0]?.response_body ?? { message: "Resource already exists." };
                            const renderedBody = renderTemplate(responseBody, ctx);
                            return res.status(409).json(renderedBody);
                        }
                    }

                    // 7️⃣ Ghi dữ liệu mới vào DB
                    const newData = [...currentData, payload];
                    await db.stateful.query(
                        `UPDATE endpoint_data_ful 
     SET data_current = $1, updated_at = NOW()
     WHERE path = $2`,
                        [JSON.stringify(newData), path]
                    );

                    // 8️⃣ Trả về response success (201)
                    const { rows: successRows } = await db.stateful.query(
                        `SELECT response_body 
     FROM endpoint_responses_ful 
     WHERE endpoint_id = $1 AND status_code = 201 LIMIT 1`,
                        [endpointInfo.id]
                    );

                    const successBody = successRows[0]?.response_body ?? { message: "Resource created successfully." };
                    const renderedBody = renderTemplate(successBody, ctx);
                    return res.status(201).json(renderedBody);
                };

                case "PUT": {
                    const payload = body;

                    // 1️⃣ Kiểm tra endpoint có stateful và active không
                    const { rows: endpointRows } = await db.stateful.query(
                        `SELECT id, path, method, is_active AS is_stateful
     FROM endpoints_ful 
     WHERE path = $1 AND UPPER(method) = $2`,
                        [endpoint.path, method]
                    );

                    const endpointInfo = endpointRows[0];
                    if (!endpointInfo) {
                        return res.status(404).json({ message: "Endpoint not found in stateful DB." });
                    }
                    if (!endpointInfo.is_stateful) {
                        return res.status(400).json({ message: "This endpoint is not enabled for stateful mode." });
                    }

                    // 2️⃣ Lấy schema & data_current từ endpoint_data_ful
                    const { rows: dataRows } = await db.stateful.query(
                        `SELECT schema, data_current FROM endpoint_data_ful WHERE path = $1 LIMIT 1`,
                        [endpoint.path]
                    );
                    if (dataRows.length === 0) {
                        return res.status(404).json({ message: "No stateful data found for this endpoint." });
                    }

                    const dataRow = dataRows[0];
                    const schema = dataRow.schema || {};
                    let currentData = Array.isArray(dataRow.data_current) ? dataRow.data_current : [];

                    // 3️⃣ Lấy ID từ URL
                    const pathParts = path.split("/").filter(Boolean);
                    const idFromUrl = Number(pathParts[pathParts.length - 1]);
                    if (isNaN(idFromUrl)) {
                        return res.status(400).json({ message: "Invalid ID in URL." });
                    }

                    // 4️⃣ Tìm item trong data_current
                    const existingIndex = currentData.findIndex(item => item.id === idFromUrl);
                    if (existingIndex === -1) {
                        const { rows: notFoundRows } = await db.stateful.query(
                            `SELECT response_body 
       FROM endpoint_responses_ful 
       WHERE endpoint_id = $1 AND status_code = 404 LIMIT 1`,
                            [endpointInfo.id]
                        );
                        let responseBody = notFoundRows[0]?.response_body ?? { message: "Not found." };
                        return res.status(404).json(responseBody);
                    }

                    // 5️⃣ Check payload hợp lệ theo schema
                    const schemaKeys = Object.keys(schema);
                    const payloadKeys = Object.keys(payload);
                    let isValid = true;

                    // ❌ Nếu có key không nằm trong schema => sai
                    const extraKeys = payloadKeys.filter(k => !schemaKeys.includes(k));
                    if (extraKeys.length > 0) {
                        isValid = false;
                    }

                    // Nếu có id trong payload thì phải đúng đủ field và kiểu
                    if (isValid && payload.id !== undefined) {
                        for (const [key, rule] of Object.entries(schema)) {
                            const value = payload[key];
                            if (rule.required && value === undefined) {
                                isValid = false;
                                break;
                            }
                            if (value !== undefined) {
                                if (rule.type === "number" && typeof value !== "number") { isValid = false; break; }
                                if (rule.type === "string" && typeof value !== "string") { isValid = false; break; }
                                if (rule.type === "boolean" && typeof value !== "boolean") { isValid = false; break; }
                            }
                        }
                    }

                    // Nếu không có id thì chỉ kiểm tra field có tồn tại trong schema và đúng kiểu
                    if (isValid && payload.id === undefined) {
                        for (const [key, value] of Object.entries(payload)) {
                            const rule = schema[key];
                            if (!rule) { // field không có trong schema
                                isValid = false;
                                break;
                            }
                            if (rule.type === "number" && typeof value !== "number") { isValid = false; break; }
                            if (rule.type === "string" && typeof value !== "string") { isValid = false; break; }
                            if (rule.type === "boolean" && typeof value !== "boolean") { isValid = false; break; }
                        }
                    }

                    if (!isValid) {
                        const { rows: respRows } = await db.stateful.query(
                            `SELECT response_body 
       FROM endpoint_responses_ful 
       WHERE endpoint_id = $1 AND status_code = 403 LIMIT 1`,
                            [endpointInfo.id]
                        );
                        let responseBody = respRows[0]?.response_body ?? { message: "Invalid data: request does not match schema." };
                        return res.status(403).json(responseBody);
                    }

                    // 6️⃣ Kiểm tra xung đột ID (payload.id khác idFromUrl)
                    if (payload.id !== undefined && payload.id !== idFromUrl) {
                        const conflict = currentData.some(item => item.id === payload.id);
                        if (conflict) {
                            const { rows: respRows } = await db.stateful.query(
                                `SELECT response_body 
        FROM endpoint_responses_ful 
        WHERE endpoint_id = $1 AND status_code = 409 LIMIT 1`,
                                [endpointInfo.id]
                            );
                            let responseBody = respRows[0]?.response_body ?? null;
                            if (typeof responseBody === "string") {
                                try { responseBody = JSON.parse(responseBody); } catch (_) { }
                            }

                            // 🔄 Thay thế lần lượt {{params.id}} trong message
                            if (responseBody && typeof responseBody.message === "string") {
                                let count = 0;
                                responseBody.message = responseBody.message.replace(/{{\s*params\.id\s*}}/g, () => {
                                    count++;
                                    if (count === 1) return idFromUrl; // lần 1 -> id trên URL
                                    if (count === 2) return payload.id ?? ""; // lần 2 -> id trong payload
                                    return ""; // các lần sau (nếu có) -> để trống hoặc thêm logic khác nếu cần
                                });
                            }

                            return res.status(409).json(responseBody);
                        }
                    }

                    // 7️⃣ Tiến hành cập nhật
                    const updatedItem = { ...currentData[existingIndex], ...payload };
                    currentData[existingIndex] = updatedItem;

                    await db.stateful.query(
                        `UPDATE endpoint_data_ful 
     SET data_current = $1, updated_at = NOW()
     WHERE path = $2`,
                        [JSON.stringify(currentData), endpoint.path]
                    );

                    // 8️⃣ Trả về response 200
                    const { rows: successRows } = await db.stateful.query(
                        `SELECT response_body 
     FROM endpoint_responses_ful 
     WHERE endpoint_id = $1 AND status_code = 200 LIMIT 1`,
                        [endpointInfo.id]
                    );
                    let responseBody = successRows[0]?.response_body ?? { message: "Updated successfully." };
                    return res.status(200).json(responseBody);
                };

                case "DELETE": {
                    // 1️⃣ Kiểm tra endpoint có stateful và active không
                    const { rows: endpointRows } = await db.stateful.query(
                        `SELECT id, path, method, is_active AS is_stateful
     FROM endpoints_ful 
     WHERE path = $1 AND UPPER(method) = $2`,
                        [endpoint.path, method]
                    );

                    const endpointInfo = endpointRows[0];
                    if (!endpointInfo) {
                        return res.status(404).json({ message: "Endpoint not found in stateful DB." });
                    }
                    if (!endpointInfo.is_stateful) {
                        return res.status(400).json({ message: "This endpoint is not enabled for stateful mode." });
                    }

                    // 2️⃣ Lấy dữ liệu hiện tại từ endpoint_data_ful
                    const { rows: dataRows } = await db.stateful.query(
                        `SELECT data_current FROM endpoint_data_ful WHERE path = $1 LIMIT 1`,
                        [endpoint.path]
                    );
                    if (dataRows.length === 0) {
                        return res.status(404).json({ message: "No stateful data found for this endpoint." });
                    }

                    let currentData = Array.isArray(dataRows[0].data_current) ? dataRows[0].data_current : [];

                    // 3️⃣ Lấy ID từ URL nếu có
                    const pathParts = path.split("/").filter(Boolean);
                    const idFromUrl = pathParts.length > 1 ? Number(pathParts[pathParts.length - 1]) : null;

                    // Helper render template
                    const renderTemplate = (responseBody, ctx) => {
                        if (!responseBody) return null;
                        if (typeof responseBody === "string") {
                            try { responseBody = JSON.parse(responseBody); } catch (_) { }
                        }
                        if (typeof responseBody === "object" && responseBody !== null) {
                            const replacer = (val) =>
                                typeof val === "string"
                                    ? val.replace(/\{\{\s*params\.id\s*\}\}/g, ctx.id ?? "")
                                    : val;
                            for (const key in responseBody) {
                                responseBody[key] = replacer(responseBody[key]);
                            }
                        }
                        return responseBody;
                    };

                    // 4️⃣ Lấy tất cả response 200 của endpoint này để kiểm tra phân biệt
                    const { rows: allSuccessResponses } = await db.stateful.query(
                        `SELECT response_body, status_code 
     FROM endpoint_responses_ful
     WHERE endpoint_id = $1 AND status_code = 200`,
                        [endpointInfo.id]
                    );

                    // 🔹 Phân loại response theo nội dung (ép kiểu về string để tránh lỗi .includes)
                    const responseDeleteById = allSuccessResponses.find(r => {
                        const bodyStr = typeof r.response_body === "string" ? r.response_body : JSON.stringify(r.response_body || "");
                        return bodyStr.includes("{{params.id}}");
                    });

                    const responseDeleteAll = allSuccessResponses.find(r => {
                        const bodyStr = typeof r.response_body === "string" ? r.response_body : JSON.stringify(r.response_body || "");
                        return !bodyStr.includes("{{params.id}}");
                    });

                    // 🔹 Trường hợp xóa tất cả (DELETE /users)
                    if (idFromUrl === null || isNaN(idFromUrl)) {
                        await db.stateful.query(
                            `UPDATE endpoint_data_ful
       SET data_current = $1, updated_at = NOW()
       WHERE path = $2`,
                            [JSON.stringify([]), endpoint.path]
                        );

                        let responseBody = responseDeleteAll?.response_body ?? null;
                        if (typeof responseBody === "string") {
                            try { responseBody = JSON.parse(responseBody); } catch (_) { }
                        }
                        return res.status(200).json(responseBody);
                    }

                    // 🔹 Trường hợp xóa theo id (DELETE /users/:id)
                    if (isNaN(idFromUrl)) {
                        const { rows: badReqRows } = await db.stateful.query(
                            `SELECT response_body 
       FROM endpoint_responses_ful
       WHERE endpoint_id = $1 AND status_code = 400 LIMIT 1`,
                            [endpointInfo.id]
                        );
                        let responseBody = badReqRows[0]?.response_body ?? null;
                        responseBody = renderTemplate(responseBody, { id: idFromUrl });
                        return res.status(400).json(responseBody);
                    }

                    const itemIndex = currentData.findIndex(item => item.id === idFromUrl);

                    if (itemIndex === -1) {
                        const { rows: notFoundRows } = await db.stateful.query(
                            `SELECT response_body 
       FROM endpoint_responses_ful
       WHERE endpoint_id = $1 AND status_code = 404 LIMIT 1`,
                            [endpointInfo.id]
                        );
                        let responseBody = notFoundRows[0]?.response_body ?? null;
                        responseBody = renderTemplate(responseBody, { id: idFromUrl });
                        return res.status(404).json(responseBody);
                    }

                    // 5️⃣ Xóa item khỏi data_current
                    currentData.splice(itemIndex, 1);

                    await db.stateful.query(
                        `UPDATE endpoint_data_ful
     SET data_current = $1, updated_at = NOW()
     WHERE path = $2`,
                        [JSON.stringify(currentData), endpoint.path]
                    );

                    // ✅ Response 200 cho DELETE /users/:id
                    let responseBody = responseDeleteById?.response_body ?? responseDeleteAll?.response_body ?? null;
                    responseBody = renderTemplate(responseBody, { id: idFromUrl });

                    return res.status(200).json(responseBody);
                };

                default:
                    return res.status(405).json({ error: `Method ${method} not supported yet.` });
            }
        } catch (err) {
            console.error("Error in statefulHandler:", err);
            return res.status(500).json({ error: "Internal Server Error", message: err.message });
        }
    },
};