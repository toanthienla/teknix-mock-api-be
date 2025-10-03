const { statefulPool } = require('../config/db');

const ResponseStatefulService = {
    async findById(id) {
        const query = 'SELECT * FROM endpoint_responses_ful WHERE id = $1;';
        const { rows } = await statefulPool.query(query, [id]);
        return rows[0] || null;
    },
    
    async findByEndpointId(endpointId) {
        const query = 'SELECT * FROM endpoint_responses_ful WHERE endpoint_id = $1;';
        const { rows } = await statefulPool.query(query, [endpointId]);
        return rows;
    },


     /**
     * Xóa một response theo ID
     * @param {number} id - ID của response cần xóa
     * @returns {boolean} - Trả về true nếu xóa thành công, false nếu không tìm thấy
     */
    async deleteById(id) {
        const query = 'DELETE FROM endpoint_responses_ful WHERE id = $1;';
        const result = await statefulPool.query(query, [id]);
        return result.rowCount > 0;
    }
};

module.exports = ResponseStatefulService;