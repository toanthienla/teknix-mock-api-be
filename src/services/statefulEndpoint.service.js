// src/services/statefulEndpoint.service.js
const { dbPool, dbPoolfull } = require("../config/db"); // phải là dbPool và dbPoolfull

/**
 * Chuyển một endpoint từ stateless sang stateful
 * @param {number} endpointId - ID của endpoint trong DB stateless
 */
async function convertToStateful(endpointId) {
    const clientStateless = await dbPool.connect();
    const clientStateful = await dbPoolfull.connect();

    try {
        await clientStateless.query("BEGIN");
        await clientStateful.query("BEGIN");

        // 1. Lấy endpoint từ stateless
        const { rows: [endpoint] } = await clientStateless.query(
            `SELECT * FROM endpoints WHERE id = $1`,
            [endpointId]
        );
        if (!endpoint) {
            throw new Error("Endpoint not found");
        }

        // 2. Update stateless endpoint
        await clientStateless.query(
            `UPDATE endpoints
             SET is_stateful = true, is_active = false, updated_at = NOW()
             WHERE id = $1`,
            [endpointId]
        );

        // 3. Insert vào stateful db
        const { rows: [statefulEndpoint] } = await clientStateful.query(
            `INSERT INTO endpoints_ful (folder_id, name, method, path, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, true, NOW(), NOW())
             RETURNING *`,
            [endpoint.folder_id, endpoint.name, endpoint.method, endpoint.path]
        );

        // Commit cả 2 DB sau khi insert thành công
        await clientStateless.query("COMMIT");
        await clientStateful.query("COMMIT");

        // 4. Sinh default responses dựa trên method
        const responsesResult = await generateDefaultResponses(statefulEndpoint);

        return {
            stateless: endpoint,
            stateful: statefulEndpoint,
            responses: responsesResult
        };

    } catch (err) {
        await clientStateless.query("ROLLBACK");
        await clientStateful.query("ROLLBACK");
        throw err;
    } finally {
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
            response_body: { message: "Creation failed: data does not follow schema." },
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
            response_body: { message: "Update failed: id in body conflicts in array." },
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
        const { rows: [response] } = await client.query(
            `SELECT * FROM endpoint_responses_ful WHERE id = $1`,
            [responseId]
        );
        if (!response) {
            throw new Error("Response not found");
        }

        // 2. Rule: GET 200 (all, detail) thì không cho chỉnh
        if (
            response.status_code === 200 &&
            (response.name === "Get All Success" || response.name === "Get Detail Success")
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
        const { rows: [updated] } = await client.query(
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
    convertToStateful,
    generateDefaultResponses,
    insertResponses,
    ResponsesForGET,
    ResponsesForPOST,
    ResponsesForPUT,
    ResponsesForDELETE,
    updateEndpointResponse,
};
