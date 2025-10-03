const { statelessPool, statefulPool } = require("../config/db");

async function convertToStateful(endpointId) {
    const clientStateless = await statelessPool.connect();
    const clientStateful = await statefulPool.connect();

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
    const client = await statefulPool.connect();
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

module.exports = {
    convertToStateful,
    generateDefaultResponses,
    insertResponses,
    ResponsesForGET,
    ResponsesForPOST,
    ResponsesForPUT,
    ResponsesForDELETE,
};
