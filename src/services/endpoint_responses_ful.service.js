const { statefulPool } = require('../config/db');

const ResponseStatefulService = {
    async findById(id) {
        const query = 'SELECT * FROM endpoint_responses_ful WHERE id = $1;';
        const { rows } = await statefulPool.query(query, [id]);
        return rows[0] || null;
    },

    async findByEndpointId(endpointId) {
        const query = 'SELECT * FROM endpoint_responses_ful WHERE endpoint_id = $1 ORDER BY created_at DESC;';
        const { rows } = await statefulPool.query(query, [endpointId]);
        return rows;
    },

    async deleteById(id) {
        const query = 'DELETE FROM endpoint_responses_ful WHERE id = $1;';
        const result = await statefulPool.query(query, [id]);
        return result.rowCount > 0;
    },

    async findByOriginId(originId) {
        const query = 'SELECT * FROM endpoint_responses_ful WHERE origin_id = $1 LIMIT 1;';
        const { rows } = await statefulPool.query(query, [originId]);
        return rows[0] || null;
    }
};

module.exports = ResponseStatefulService;